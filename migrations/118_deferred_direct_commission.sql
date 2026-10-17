-- Direct referral commissions remain pending until the weekly Friday 12:00 AM Cairo update.
-- Older commissions that already have a wallet transaction were already credited; preserve their balances.
UPDATE network_direct_commissions c
   SET status='paid', paid_at=COALESCE(c.paid_at,now())
 WHERE c.status='pending'
   AND EXISTS (
     SELECT 1 FROM wallet_transactions wt
      WHERE wt.user_id=c.marketer_id
        AND wt.reference='direct-commission:'||c.order_id::text
   )
   AND EXISTS (SELECT 1 FROM orders o WHERE o.id=c.order_id);

CREATE OR REPLACE FUNCTION credit_direct_commission_for_order(p_order_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
DECLARE
  sponsor text;
  inserted_count integer;
BEGIN
  SELECT buyer.sponsor_id::text
    INTO sponsor
    FROM orders o
    JOIN app_profiles buyer ON buyer.id=o.marketer_id
   WHERE o.id=p_order_id
     AND o.status='paid'
     AND buyer.role='marketer'
     AND buyer.deleted_at IS NULL
     AND buyer.sponsor_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM order_items oi
       JOIN products pr ON pr.id=oi.product_id
       WHERE oi.order_id=o.id AND pr.commissionable=true
     )
   LIMIT 1;

  IF sponsor IS NULL THEN RETURN false; END IF;

  INSERT INTO network_direct_commissions(marketer_id,order_id,amount,status)
  VALUES(sponsor,p_order_id,250,'pending')
  ON CONFLICT(marketer_id,order_id) DO NOTHING;

  -- Intentionally do not write to wallets or wallet_transactions here.
  -- Purchase creates a deferred entry only; the weekly scheduler releases it.
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION release_due_direct_commissions(p_cutoff timestamptz)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
DECLARE
  c record;
  previous_hatchable_user text;
  previous_wallet_user text;
  credited_tx uuid;
  released integer := 0;
BEGIN
  FOR c IN
    SELECT d.id,d.marketer_id,d.order_id,d.amount
      FROM network_direct_commissions d
      JOIN orders o ON o.id=d.order_id
     WHERE d.status='pending'
       AND d.created_at < p_cutoff
     ORDER BY d.created_at,d.id
     FOR UPDATE OF d
  LOOP
    previous_hatchable_user := current_setting('hatchable.user_id',true);
    previous_wallet_user := current_setting('together.wallet_user_id',true);
    PERFORM set_config('hatchable.user_id',c.marketer_id::text,true);
    PERFORM set_config('together.wallet_user_id',c.marketer_id::text,true);

    credited_tx := NULL;
    INSERT INTO wallet_transactions(user_id,type,amount,reference)
    VALUES(c.marketer_id,'direct_commission',c.amount,'direct-commission:'||c.order_id::text)
    ON CONFLICT(user_id,reference)
      WHERE reference LIKE 'direct-commission:%'
    DO NOTHING
    RETURNING id INTO credited_tx;

    IF credited_tx IS NOT NULL THEN
      INSERT INTO wallets(user_id,balance)
      VALUES(c.marketer_id,c.amount)
      ON CONFLICT(user_id) DO UPDATE
        SET balance=wallets.balance+EXCLUDED.balance,updated_at=now();
    END IF;

    UPDATE network_direct_commissions
       SET status='paid',paid_at=COALESCE(paid_at,now())
     WHERE id=c.id AND status='pending';

    PERFORM set_config('hatchable.user_id',COALESCE(previous_hatchable_user,''),true);
    PERFORM set_config('together.wallet_user_id',COALESCE(previous_wallet_user,''),true);
    released := released+1;
  END LOOP;
  RETURN released;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('hatchable.user_id',COALESCE(previous_hatchable_user,''),true);
  PERFORM set_config('together.wallet_user_id',COALESCE(previous_wallet_user,''),true);
  RAISE;
END;
$function$;