-- Atomic checkout now records the purchase BV for every upline on the correct account side.
-- The existing v235 code remains recoverable through Hatchable deployment history.
-- v237 correction: include newly inserted ledger rows when refreshing aggregates; sibling data-modifying CTEs share a statement snapshot.
CREATE OR REPLACE FUNCTION checkout_store_order(
  p_user_id text,
  p_items jsonb,
  p_country text,
  p_governorate text,
  p_address text,
  p_phone text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
DECLARE
  result jsonb;
  previous_hatchable_user text;
  previous_wallet_user text;
BEGIN
  previous_hatchable_user := current_setting('hatchable.user_id', true);
  previous_wallet_user := current_setting('together.wallet_user_id', true);
  PERFORM set_config('hatchable.user_id', p_user_id, true);
  PERFORM set_config('together.wallet_user_id', p_user_id, true);

  IF NOT EXISTS (
    SELECT 1 FROM app_profiles
    WHERE id::text = p_user_id
      AND role = 'marketer'
      AND deleted_at IS NULL
      AND COALESCE(login_blocked, false) = false
  ) THEN
    RAISE EXCEPTION 'marketer_not_found';
  END IF;

  INSERT INTO wallets(user_id, balance)
  SELECT p_user_id,
    GREATEST(0, COALESCE((
      SELECT SUM(CASE WHEN action = 'remove' THEN -ABS(amount) ELSE ABS(amount) END)
      FROM admin_manual_wallet_actions
      WHERE marketer_id::text = p_user_id
    ), 0))
  ON CONFLICT (user_id) DO UPDATE
    SET balance = CASE
      WHEN wallets.balance = 0
       AND NOT EXISTS (
         SELECT 1 FROM wallet_transactions WHERE user_id::text = p_user_id
       )
      THEN EXCLUDED.balance
      ELSE wallets.balance
    END,
    updated_at = now();

  WITH RECURSIVE
  requested AS (
    SELECT product_id::uuid, quantity
    FROM jsonb_to_recordset(p_items) AS x(product_id text, quantity integer)
  ),
  priced AS (
    SELECT r.product_id, r.quantity, p.name, p.price, p.bv, p.active, p.stock
    FROM requested r JOIN products p ON p.id = r.product_id
    FOR UPDATE
  ),
  valid AS (
    SELECT COUNT(*) = (SELECT COUNT(*) FROM requested)
      AND COUNT(*) > 0
      AND BOOL_AND(active = true AND stock >= quantity AND price >= 0 AND bv >= 0 AND quantity > 0) AS ok
    FROM priced
  ),
  totals AS (
    SELECT COALESCE(SUM(quantity * price), 0)::numeric AS total,
           COALESCE(SUM(quantity * bv), 0)::integer AS total_bv
    FROM priced
  ),
  wallet_debit AS (
    UPDATE wallets w
    SET balance = w.balance - t.total, updated_at = now()
    FROM totals t, valid v
    WHERE w.user_id::text = p_user_id AND v.ok AND w.balance >= t.total
    RETURNING w.balance
  ),
  updated AS (
    UPDATE products p
    SET stock = p.stock - pr.quantity
    FROM priced pr, valid v, wallet_debit wd
    WHERE v.ok AND p.id = pr.product_id
    RETURNING p.id
  ),
  ins_order AS (
    INSERT INTO orders(customer_id, marketer_id, status, total, shipping_country, shipping_governorate, shipping_address, shipping_phone, payment_method)
    SELECT p_user_id, p_user_id, 'paid', t.total, p_country, p_governorate, p_address, p_phone, 'wallet'
    FROM totals t, valid v, wallet_debit wd
    WHERE v.ok AND (SELECT COUNT(*) FROM updated) = (SELECT COUNT(*) FROM requested)
    RETURNING id, total, status, created_at
  ),
  ins_items AS (
    INSERT INTO order_items(order_id, product_id, quantity, unit_price, bv)
    SELECT o.id, p.product_id, p.quantity, p.price, p.bv
    FROM ins_order o CROSS JOIN priced p
    RETURNING id
  ),
  wallet_tx AS (
    INSERT INTO wallet_transactions(user_id, type, amount, reference)
    SELECT p_user_id, 'store_purchase', -o.total, 'store-order:' || o.id::text
    FROM ins_order o
    RETURNING id
  ),
  chain AS (
    SELECT p.owner_marketer_id::text AS upline_member_id,
           p.account_position, p.side,
           ARRAY[p_user_id, p.owner_marketer_id::text]::text[] AS seen
    FROM network_placements p
    WHERE p.member_id::text = p_user_id
    UNION ALL
    SELECT p.owner_marketer_id::text,
           p.account_position, p.side,
           c.seen || p.owner_marketer_id::text
    FROM chain c
    JOIN network_placements p
      ON p.member_id::text = c.upline_member_id
     AND p.account_position = c.account_position
    WHERE NOT p.owner_marketer_id::text = ANY(c.seen)
  ),
  bv_ledger AS (
    INSERT INTO network_bv_ledger
      (order_id, source_member_id, upline_member_id, account_position, side, bv, sale_at)
    SELECT o.id::text, p_user_id, c.upline_member_id, c.account_position, c.side,
           t.total_bv, o.created_at
    FROM ins_order o
    CROSS JOIN totals t
    CROSS JOIN chain c
    WHERE t.total_bv > 0
    ON CONFLICT (order_id, upline_member_id, account_position, side) DO NOTHING
    RETURNING upline_member_id, account_position, side, bv
  ),
  refreshed AS (
    INSERT INTO network_bv_balances
      (member_id, account_position, total_right, total_left)
    SELECT c.upline_member_id, c.account_position,
           COALESCE((SELECT SUM(l.bv) FROM network_bv_ledger l
                     WHERE l.upline_member_id = c.upline_member_id
                       AND l.account_position = c.account_position
                       AND l.side = 'right'), 0)
             + COALESCE((SELECT SUM(i.bv) FROM bv_ledger i
                         WHERE i.upline_member_id = c.upline_member_id
                           AND i.account_position = c.account_position
                           AND i.side = 'right'), 0),
           COALESCE((SELECT SUM(l.bv) FROM network_bv_ledger l
                     WHERE l.upline_member_id = c.upline_member_id
                       AND l.account_position = c.account_position
                       AND l.side = 'left'), 0)
             + COALESCE((SELECT SUM(i.bv) FROM bv_ledger i
                         WHERE i.upline_member_id = c.upline_member_id
                           AND i.account_position = c.account_position
                           AND i.side = 'left'), 0)
    FROM (SELECT DISTINCT upline_member_id, account_position FROM chain) c
    ON CONFLICT (member_id, account_position) DO UPDATE
      SET total_right = EXCLUDED.total_right,
          total_left = EXCLUDED.total_left,
          updated_at = now()
    RETURNING member_id
  )
  SELECT jsonb_build_object(
    'order_data', (SELECT to_jsonb(ins_order) FROM ins_order),
    'item_count', (SELECT COUNT(*) FROM ins_items),
    'valid', (SELECT ok FROM valid),
    'balance_after', (SELECT balance FROM wallet_debit),
    'total_bv', (SELECT total_bv FROM totals),
    'bv_credited_uplines', (SELECT COUNT(*) FROM bv_ledger),
    'found', (SELECT COUNT(*) FROM priced),
    'requested', (SELECT COUNT(*) FROM requested),
    'required', (SELECT total FROM totals),
    'balance', (SELECT balance FROM wallets WHERE user_id::text = p_user_id)
  )
  INTO result;

  PERFORM set_config('hatchable.user_id', COALESCE(previous_hatchable_user, ''), true);
  PERFORM set_config('together.wallet_user_id', COALESCE(previous_wallet_user, ''), true);
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('hatchable.user_id', COALESCE(previous_hatchable_user, ''), true);
  PERFORM set_config('together.wallet_user_id', COALESCE(previous_wallet_user, ''), true);
  RAISE;
END;
$function$;