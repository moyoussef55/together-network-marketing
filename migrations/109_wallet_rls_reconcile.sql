CREATE OR REPLACE FUNCTION reconcile_legacy_marketer_wallet(p_user_id text)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
DECLARE
  target_balance numeric;
  current_balance numeric;
BEGIN
  SELECT GREATEST(0, COALESCE(SUM(
    CASE WHEN action = 'remove' THEN -ABS(amount) ELSE ABS(amount) END
  ), 0))
  INTO target_balance
  FROM admin_manual_wallet_actions
  WHERE marketer_id = p_user_id;

  INSERT INTO wallets(user_id, balance)
  VALUES (p_user_id, target_balance)
  ON CONFLICT (user_id) DO UPDATE
    SET balance = CASE
      WHEN wallets.balance = 0
       AND NOT EXISTS (
         SELECT 1 FROM wallet_transactions
         WHERE user_id = p_user_id
       )
      THEN EXCLUDED.balance
      ELSE wallets.balance
    END,
    updated_at = now();

  SELECT balance INTO current_balance
  FROM wallets WHERE user_id = p_user_id;

  RETURN COALESCE(current_balance, 0);
END;
$function$;