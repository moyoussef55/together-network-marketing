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
    WHERE NOT p.owner_marketer_id::text = ANY(c.seen)
  ),
  expected_positions AS (
    SELECT DISTINCT c.upline_member_id,
           CASE WHEN NOT EXISTS (
             SELECT 1 FROM network_placements parent
              WHERE parent.member_id::text = c.upline_member_id
           ) THEN 1 ELSE c.account_position END AS account_position,
           CASE WHEN NOT EXISTS (
             SELECT 1 FROM network_placements parent
              WHERE parent.member_id::text = c.upline_member_id
           ) THEN CASE c.account_position WHEN 2 THEN 'left' WHEN 3 THEN 'right' ELSE c.side END
           ELSE c.side END AS side
    FROM chain c
    UNION
    SELECT DISTINCT c.upline_member_id, 1 AS account_position,
           CASE c.account_position WHEN 2 THEN 'left' WHEN 3 THEN 'right' ELSE c.side END AS side
    FROM chain c
    WHERE c.account_position <> 1
      AND EXISTS (SELECT 1 FROM network_placements parent WHERE parent.member_id::text = c.upline_member_id)
  ),
  active_expected_positions AS (
    SELECT DISTINCT ep.upline_member_id, ep.account_position, ep.side
    FROM expected_positions ep
    JOIN ins_order o ON true
    JOIN app_profiles recipient ON recipient.id = ep.upline_member_id
    JOIN app_profiles source_profile ON source_profile.id::text = p_user_id
    CROSS JOIN LATERAL (
      SELECT COALESCE(SUM(oi.quantity * pr.bv) FILTER (WHERE pr.commissionable = true), 0)::int AS purchase_bv
      FROM orders own_o
      JOIN order_items oi ON oi.order_id = own_o.id
      JOIN products pr ON pr.id = oi.product_id
      WHERE own_o.marketer_id = recipient.id
        AND own_o.status = ANY(ARRAY['paid','processing','shipped','delivered','completed']::text[])
        AND own_o.created_at <= o.created_at
    ) own
    WHERE source_profile.status = 'active'
      AND source_profile.activation_started_at IS NOT NULL
      AND source_profile.activation_started_at <= o.created_at
      AND COALESCE(source_profile.activation_blocked, false) = false
      AND source_profile.deleted_at IS NULL
      AND recipient.status = 'active'
      AND recipient.activation_started_at IS NOT NULL
      AND recipient.activation_started_at <= source_profile.activation_started_at
      AND recipient.activation_started_at <= o.created_at
      AND COALESCE(recipient.activation_blocked, false) = false
      AND recipient.deleted_at IS NULL
      AND ep.account_position <= GREATEST(
        COALESCE(recipient.admin_tier_override, 0),
        CASE WHEN own.purchase_bv >= 3000 THEN 3
             WHEN own.purchase_bv >= 2000 THEN 2
             WHEN own.purchase_bv >= 1000 THEN 1
             ELSE 0 END
      )
  ),
  bv_ledger AS (
    INSERT INTO network_bv_ledger
      (order_id, source_member_id, upline_member_id, account_position, side, bv, sale_at)
    SELECT o.id::text, p_user_id, ep.upline_member_id, ep.account_position, ep.side,
           t.total_bv, o.created_at
    FROM ins_order o
    CROSS JOIN totals t
    CROSS JOIN active_expected_positions ep
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
    FROM (SELECT DISTINCT upline_member_id, account_position FROM active_expected_positions) c
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


-- Initialize the known-active TOe0468 subtree from the recorded moment each profile
-- entered the database as active. The rule below never credits a sale to an upline
-- whose activation timestamp is later than the seller's activation timestamp.
WITH RECURSIVE target_tree(id) AS (
  SELECT p.id::text
    FROM app_profiles p
   WHERE p.referral_code = 'TOe0468' AND p.role = 'marketer'
  UNION
  SELECT np.member_id::text
    FROM network_placements np
    JOIN target_tree t ON np.parent_member_id::text = t.id
)
UPDATE app_profiles p
   SET activation_started_at = COALESCE(p.created_at, now())
  FROM target_tree t
 WHERE p.id::text = t.id
   AND p.role = 'marketer'
   AND p.status = 'active'
   AND p.activation_started_at IS NULL
   AND COALESCE(p.activation_blocked, false) = false
   AND p.deleted_at IS NULL;

-- Backfill missing BV rows for purchases in this one subtree only. Existing rows and
-- settled cheques are preserved; the unique key makes the insert idempotent.
WITH RECURSIVE target_tree(id) AS (
  SELECT p.id::text
    FROM app_profiles p
   WHERE p.referral_code = 'TOe0468' AND p.role = 'marketer'
  UNION
  SELECT np.member_id::text
    FROM network_placements np
    JOIN target_tree t ON np.parent_member_id::text = t.id
),
qualified_orders AS (
  SELECT o.id::text AS order_id,
         o.marketer_id::text AS source_member_id,
         COALESCE(o.created_at, now()) AS sale_at,
         source.activation_started_at AS source_activation_at,
         COALESCE(SUM(oi.quantity * pr.bv) FILTER (WHERE pr.commissionable = true), 0)::int AS bv
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    JOIN products pr ON pr.id = oi.product_id
    JOIN app_profiles source ON source.id::text = o.marketer_id::text
   WHERE o.marketer_id::text IN (SELECT id FROM target_tree)
     AND o.status = ANY(ARRAY['paid','processing','shipped','delivered','completed']::text[])
     AND source.activation_started_at IS NOT NULL
     AND source.activation_started_at <= COALESCE(o.created_at, now())
     AND source.status = 'active'
     AND COALESCE(source.activation_blocked, false) = false
     AND source.deleted_at IS NULL
   GROUP BY o.id, o.marketer_id, o.created_at, source.activation_started_at
  HAVING COALESCE(SUM(oi.quantity * pr.bv) FILTER (WHERE pr.commissionable = true), 0) > 0
),
chain AS (
  SELECT q.order_id, q.source_member_id, q.sale_at, q.source_activation_at, q.bv,
         p.owner_marketer_id::text AS upline_member_id,
         p.account_position, p.side,
         ARRAY[q.source_member_id, p.owner_marketer_id::text]::text[] AS seen
    FROM qualified_orders q
    JOIN network_placements p ON p.member_id::text = q.source_member_id
  UNION ALL
  SELECT c.order_id, c.source_member_id, c.sale_at, c.source_activation_at, c.bv,
         p.owner_marketer_id::text, p.account_position, p.side,
         c.seen || p.owner_marketer_id::text
    FROM chain c
    JOIN network_placements p ON p.member_id::text = c.upline_member_id
   WHERE NOT p.owner_marketer_id::text = ANY(c.seen)
),
expected_positions AS (
  SELECT DISTINCT c.order_id, c.source_member_id, c.sale_at, c.source_activation_at, c.bv,
         c.upline_member_id,
         CASE WHEN NOT EXISTS (
           SELECT 1 FROM network_placements parent
            WHERE parent.member_id::text = c.upline_member_id
         ) THEN 1 ELSE c.account_position END AS account_position,
         CASE WHEN NOT EXISTS (
           SELECT 1 FROM network_placements parent
            WHERE parent.member_id::text = c.upline_member_id
         ) THEN CASE c.account_position WHEN 2 THEN 'left' WHEN 3 THEN 'right' ELSE c.side END
         ELSE c.side END AS side
    FROM chain c
  UNION
  SELECT DISTINCT c.order_id, c.source_member_id, c.sale_at, c.source_activation_at, c.bv,
         c.upline_member_id, 1 AS account_position,
         CASE c.account_position WHEN 2 THEN 'left' WHEN 3 THEN 'right' ELSE c.side END AS side
    FROM chain c
   WHERE c.account_position <> 1
     AND EXISTS (SELECT 1 FROM network_placements parent WHERE parent.member_id::text = c.upline_member_id)
),
active_expected_positions AS (
  SELECT DISTINCT ep.order_id, ep.source_member_id, ep.sale_at, ep.source_activation_at, ep.bv,
         ep.upline_member_id, ep.account_position, ep.side
    FROM expected_positions ep
    JOIN app_profiles recipient ON recipient.id::text = ep.upline_member_id
    CROSS JOIN LATERAL (
      SELECT COALESCE(SUM(oi.quantity * pr.bv) FILTER (WHERE pr.commissionable = true), 0)::int AS purchase_bv
        FROM orders own_o
        JOIN order_items oi ON oi.order_id = own_o.id
        JOIN products pr ON pr.id = oi.product_id
       WHERE own_o.marketer_id::text = recipient.id::text
         AND own_o.status = ANY(ARRAY['paid','processing','shipped','delivered','completed']::text[])
         AND own_o.created_at <= ep.sale_at
    ) own
   WHERE recipient.activation_started_at IS NOT NULL
     AND recipient.activation_started_at <= ep.sale_at
     AND recipient.activation_started_at <= ep.source_activation_at
     AND recipient.status = 'active'
     AND COALESCE(recipient.activation_blocked, false) = false
     AND recipient.deleted_at IS NULL
     AND ep.account_position <= GREATEST(
       COALESCE(recipient.admin_tier_override, 0),
       CASE WHEN own.purchase_bv >= 3000 THEN 3
            WHEN own.purchase_bv >= 2000 THEN 2
            WHEN own.purchase_bv >= 1000 THEN 1
            ELSE 0 END
     )
)
INSERT INTO network_bv_ledger
  (order_id, source_member_id, upline_member_id, account_position, side, bv, sale_at)
SELECT order_id, source_member_id, upline_member_id, account_position, side, bv, sale_at
  FROM active_expected_positions
ON CONFLICT (order_id, upline_member_id, account_position, side) DO NOTHING;

-- Refresh cumulative totals only for marketers in the affected subtree.
-- Carry remains in place and the UI calculates the unsettled current-cycle carry from the ledger.
WITH RECURSIVE target_tree(id) AS (
  SELECT p.id::text
    FROM app_profiles p
   WHERE p.referral_code = 'TOe0468' AND p.role = 'marketer'
  UNION
  SELECT np.member_id::text
    FROM network_placements np
    JOIN target_tree t ON np.parent_member_id::text = t.id
),
branch_totals AS (
  SELECT l.upline_member_id::text AS member_id,
         l.account_position,
         COALESCE(SUM(l.bv) FILTER (WHERE l.side = 'right'), 0)::bigint AS total_right,
         COALESCE(SUM(l.bv) FILTER (WHERE l.side = 'left'), 0)::bigint AS total_left
    FROM network_bv_ledger l
   WHERE l.upline_member_id::text IN (SELECT id FROM target_tree)
   GROUP BY l.upline_member_id, l.account_position
)
INSERT INTO network_bv_balances(member_id, account_position, total_right, total_left, updated_at)
SELECT member_id, account_position, total_right, total_left, now()
  FROM branch_totals
ON CONFLICT (member_id, account_position) DO UPDATE
  SET total_right = EXCLUDED.total_right,
      total_left = EXCLUDED.total_left,
      updated_at = now();