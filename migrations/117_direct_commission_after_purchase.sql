-- Credit the 250 EGP direct referral commission only after a qualifying purchase.
-- The function is idempotent per sponsor/order and keeps wallet writes inside a trusted DB routine.
CREATE UNIQUE INDEX IF NOT EXISTS wallet_transactions_direct_commission_ref_uq
  ON wallet_transactions(user_id, reference)
  WHERE reference LIKE 'direct-commission:%';

CREATE OR REPLACE FUNCTION credit_direct_commission_for_order(p_order_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
DECLARE
  sponsor text;
  credited_tx uuid;
  previous_hatchable_user text;
  previous_wallet_user text;
BEGIN
  SELECT buyer.sponsor_id::text
    INTO sponsor
    FROM orders o
    JOIN app_profiles buyer ON buyer.id = o.marketer_id
   WHERE o.id = p_order_id
     AND o.status = 'paid'
     AND buyer.role = 'marketer'
     AND buyer.deleted_at IS NULL
     AND buyer.sponsor_id IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM order_items oi
         JOIN products pr ON pr.id = oi.product_id
        WHERE oi.order_id = o.id
          AND pr.commissionable = true
     )
   LIMIT 1;

  IF sponsor IS NULL THEN
    RETURN false;
  END IF;

  INSERT INTO network_direct_commissions(marketer_id, order_id, amount, status)
  VALUES (sponsor, p_order_id, 250, 'pending')
  ON CONFLICT (marketer_id, order_id) DO NOTHING;

  previous_hatchable_user := current_setting('hatchable.user_id', true);
  previous_wallet_user := current_setting('together.wallet_user_id', true);
  PERFORM set_config('hatchable.user_id', sponsor, true);
  PERFORM set_config('together.wallet_user_id', sponsor, true);

  INSERT INTO wallet_transactions(user_id, type, amount, reference)
  VALUES (sponsor, 'direct_commission', 250, 'direct-commission:' || p_order_id::text)
  ON CONFLICT (user_id, reference)
    WHERE reference LIKE 'direct-commission:%'
  DO NOTHING
  RETURNING id INTO credited_tx;

  IF credited_tx IS NOT NULL THEN
    INSERT INTO wallets(user_id, balance)
    VALUES (sponsor, 250)
    ON CONFLICT (user_id) DO UPDATE
      SET balance = wallets.balance + 250,
          updated_at = now();
  END IF;

  PERFORM set_config('hatchable.user_id', COALESCE(previous_hatchable_user, ''), true);
  PERFORM set_config('together.wallet_user_id', COALESCE(previous_wallet_user, ''), true);
  RETURN credited_tx IS NOT NULL;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('hatchable.user_id', COALESCE(previous_hatchable_user, ''), true);
  PERFORM set_config('together.wallet_user_id', COALESCE(previous_wallet_user, ''), true);
  RAISE;
END;
$function$;