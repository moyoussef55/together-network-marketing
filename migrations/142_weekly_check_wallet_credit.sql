-- Idempotent crediting for weekly network checks.
CREATE UNIQUE INDEX IF NOT EXISTS wallet_transactions_weekly_check_ref_uq
  ON wallet_transactions(user_id, reference)
  WHERE reference LIKE 'weekly-check:%';

CREATE OR REPLACE FUNCTION credit_weekly_check_to_wallet(
  p_user_id text,
  p_amount numeric,
  p_reference text
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  previous_hatchable_user text;
  previous_wallet_user text;
  credited_tx uuid;
BEGIN
  IF COALESCE(p_amount,0) <= 0 OR COALESCE(p_user_id,'') = '' OR COALESCE(p_reference,'') = '' THEN
    RETURN false;
  END IF;

  previous_hatchable_user := current_setting('hatchable.user_id',true);
  previous_wallet_user := current_setting('together.wallet_user_id',true);
  PERFORM set_config('hatchable.user_id',p_user_id,true);
  PERFORM set_config('together.wallet_user_id',p_user_id,true);

  INSERT INTO wallet_transactions(user_id,type,amount,reference)
  VALUES(p_user_id,'weekly_check',p_amount,p_reference)
  ON CONFLICT(user_id,reference)
    WHERE reference LIKE 'weekly-check:%'
  DO NOTHING
  RETURNING id INTO credited_tx;

  IF credited_tx IS NOT NULL THEN
    INSERT INTO wallets(user_id,balance)
    VALUES(p_user_id,p_amount)
    ON CONFLICT(user_id) DO UPDATE
      SET balance=wallets.balance+EXCLUDED.balance,updated_at=now();
  END IF;

  PERFORM set_config('hatchable.user_id',COALESCE(previous_hatchable_user,''),true);
  PERFORM set_config('together.wallet_user_id',COALESCE(previous_wallet_user,''),true);
  RETURN credited_tx IS NOT NULL;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('hatchable.user_id',COALESCE(previous_hatchable_user,''),true);
  PERFORM set_config('together.wallet_user_id',COALESCE(previous_wallet_user,''),true);
  RAISE;
END;
$$;