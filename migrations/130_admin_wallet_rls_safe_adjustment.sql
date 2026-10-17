-- RLS-safe administrative wallet mutations.
CREATE OR REPLACE FUNCTION admin_adjust_marketer_wallet(
  p_user_id text, p_delta numeric, p_action text, p_actor text, p_reference text
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
DECLARE
  previous_user_id text;
  current_balance numeric;
BEGIN
  IF p_delta IS NULL OR p_delta = 0 OR p_action NOT IN ('add','remove') OR
     (p_action = 'add' AND p_delta < 0) OR (p_action = 'remove' AND p_delta > 0) THEN
    RAISE EXCEPTION 'invalid_wallet_adjustment';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app_profiles
    WHERE id::text = p_user_id AND role = 'marketer' AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'marketer_not_found';
  END IF;

  previous_user_id := current_setting('together.wallet_user_id', true);
  PERFORM set_config('together.wallet_user_id', p_user_id, true);

  IF p_delta > 0 THEN
    INSERT INTO wallets(user_id, balance)
    VALUES (p_user_id, p_delta)
    ON CONFLICT (user_id) DO UPDATE
      SET balance = wallets.balance + EXCLUDED.balance, updated_at = now();
    SELECT balance INTO current_balance FROM wallets WHERE user_id::text = p_user_id;
  ELSE
    UPDATE wallets
       SET balance = balance + p_delta, updated_at = now()
     WHERE user_id::text = p_user_id AND balance >= ABS(p_delta)
     RETURNING balance INTO current_balance;
    IF current_balance IS NULL THEN
      PERFORM set_config('together.wallet_user_id', COALESCE(previous_user_id, ''), true);
      RETURN NULL;
    END IF;
  END IF;

  INSERT INTO wallet_transactions(user_id, type, amount, reference)
  VALUES (p_user_id, 'admin_' || p_action, ABS(p_delta), p_reference);
  INSERT INTO admin_manual_wallet_actions(marketer_id, amount, action, created_by)
  VALUES (p_user_id, ABS(p_delta), p_action, p_actor);

  PERFORM set_config('together.wallet_user_id', COALESCE(previous_user_id, ''), true);
  RETURN current_balance;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('together.wallet_user_id', COALESCE(previous_user_id, ''), true);
  RAISE;
END;
$function$;

CREATE OR REPLACE FUNCTION admin_set_marketer_wallet_balance(p_user_id text, p_balance numeric)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
DECLARE
  previous_user_id text;
  current_balance numeric;
BEGIN
  IF p_balance IS NULL OR p_balance < 0 THEN
    RAISE EXCEPTION 'invalid_wallet_balance';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app_profiles
    WHERE id::text = p_user_id AND role = 'marketer' AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'marketer_not_found';
  END IF;

  previous_user_id := current_setting('together.wallet_user_id', true);
  PERFORM set_config('together.wallet_user_id', p_user_id, true);

  INSERT INTO wallets(user_id, balance)
  VALUES (p_user_id, p_balance)
  ON CONFLICT (user_id) DO UPDATE
    SET balance = EXCLUDED.balance, updated_at = now();

  INSERT INTO wallet_transactions(user_id, type, amount, reference, created_at)
  SELECT a.marketer_id, CASE WHEN a.action = 'remove' THEN 'admin_remove' ELSE 'admin_add' END,
         CASE WHEN a.action = 'remove' THEN -ABS(a.amount) ELSE ABS(a.amount) END,
         'admin-recovery:' || a.id::text, a.created_at
    FROM admin_manual_wallet_actions a
   WHERE a.marketer_id = p_user_id
     AND NOT EXISTS (
       SELECT 1 FROM wallet_transactions w
        WHERE w.user_id = a.marketer_id
          AND w.reference = 'admin-recovery:' || a.id::text
     );

  SELECT balance INTO current_balance FROM wallets WHERE user_id::text = p_user_id;
  PERFORM set_config('together.wallet_user_id', COALESCE(previous_user_id, ''), true);
  RETURN COALESCE(current_balance, 0);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('together.wallet_user_id', COALESCE(previous_user_id, ''), true);
  RAISE;
END;
$function$;