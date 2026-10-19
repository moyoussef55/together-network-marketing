-- Resolve the marketer identity from the withdrawal row itself.
-- The admin list is authoritative for the withdrawal UUID; frontend data attributes
-- should not be able to make a valid request look missing due to a stale/missing user id.
CREATE OR REPLACE FUNCTION admin_set_network_withdrawal_status(
  p_withdrawal_id uuid,
  p_user_id text,
  p_status text,
  p_reason text DEFAULT NULL,
  p_admin_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app_a8bd59e089a78f6d, public
AS $$
DECLARE
  w withdrawal_requests%ROWTYPE;
  wallet_balance numeric;
  ledger_balance numeric;
  next_balance numeric;
  clean_reason text := NULLIF(btrim(COALESCE(p_reason,'')),'');
  previous_withdrawal_access text;
  previous_wallet_user text;
BEGIN
  IF p_status NOT IN ('completed','rejected','cancelled') THEN
    RETURN jsonb_build_object('ok',false,'error','invalid_withdrawal_status');
  END IF;
  IF p_status IN ('rejected','cancelled') AND clean_reason IS NULL THEN
    RETURN jsonb_build_object('ok',false,'error','rejection_reason_required');
  END IF;

  previous_withdrawal_access := current_setting('together.admin_withdrawals_access',true);
  previous_wallet_user := current_setting('together.wallet_user_id',true);
  PERFORM set_config('together.admin_withdrawals_access','true',true);

  -- Look up by the unique request ID first, then use its canonical owner ID.
  SELECT * INTO w FROM withdrawal_requests WHERE id=p_withdrawal_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM set_config('together.admin_withdrawals_access',COALESCE(previous_withdrawal_access,''),true);
    PERFORM set_config('together.wallet_user_id',COALESCE(previous_wallet_user,''),true);
    RETURN jsonb_build_object('ok',false,'error','withdrawal_not_found','withdrawal_id',p_withdrawal_id);
  END IF;
  p_user_id := w.user_id;
  PERFORM set_config('together.wallet_user_id',p_user_id,true);

  IF lower(COALESCE(w.status,'pending')) IN ('completed','paid','approved','done') THEN
    PERFORM set_config('together.admin_withdrawals_access',COALESCE(previous_withdrawal_access,''),true);
    PERFORM set_config('together.wallet_user_id',COALESCE(previous_wallet_user,''),true);
    IF p_status='completed' THEN
      RETURN jsonb_build_object('ok',true,'already_completed',true,'amount',w.amount,'status',w.status);
    END IF;
    RETURN jsonb_build_object('ok',false,'error','completed_withdrawal_cannot_be_reopened');
  END IF;

  IF lower(COALESCE(w.status,'pending')) NOT IN ('pending','requested','processing') THEN
    PERFORM set_config('together.admin_withdrawals_access',COALESCE(previous_withdrawal_access,''),true);
    PERFORM set_config('together.wallet_user_id',COALESCE(previous_wallet_user,''),true);
    RETURN jsonb_build_object('ok',false,'error','withdrawal_not_pending','status',w.status);
  END IF;

  IF p_status='completed' THEN
    SELECT balance INTO wallet_balance FROM wallets WHERE user_id::text=p_user_id FOR UPDATE;
    IF FOUND THEN
      IF COALESCE(wallet_balance,0) < w.amount THEN
        PERFORM set_config('together.admin_withdrawals_access',COALESCE(previous_withdrawal_access,''),true);
        PERFORM set_config('together.wallet_user_id',COALESCE(previous_wallet_user,''),true);
        RETURN jsonb_build_object('ok',false,'error','insufficient_wallet_balance','available_balance',COALESCE(wallet_balance,0));
      END IF;
      UPDATE wallets SET balance=balance-w.amount,updated_at=now() WHERE user_id::text=p_user_id;
    ELSE
      ledger_balance := COALESCE(get_admin_marketer_wallet_balance(p_user_id),0);
      next_balance := ledger_balance-w.amount;
      IF next_balance < 0 THEN
        PERFORM set_config('together.admin_withdrawals_access',COALESCE(previous_withdrawal_access,''),true);
        PERFORM set_config('together.wallet_user_id',COALESCE(previous_wallet_user,''),true);
        RETURN jsonb_build_object('ok',false,'error','insufficient_wallet_balance','available_balance',ledger_balance);
      END IF;
      INSERT INTO wallets(user_id,balance) VALUES(p_user_id,next_balance);
    END IF;
    INSERT INTO wallet_transactions(user_id,type,amount,reference)
      VALUES(p_user_id,'withdrawal',-w.amount,'withdrawal:'||w.id::text);
    UPDATE withdrawal_requests SET status='completed',note=NULL WHERE id=w.id;
  ELSE
    UPDATE withdrawal_requests SET status=p_status,note=clean_reason WHERE id=w.id;
  END IF;

  INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata)
    VALUES(p_admin_id,'withdrawal_'||p_status,'withdrawal',w.id::text,
      jsonb_build_object('withdrawal_id',w.id,'user_id',p_user_id,'amount',w.amount,'reason',clean_reason));

  PERFORM set_config('together.admin_withdrawals_access',COALESCE(previous_withdrawal_access,''),true);
  PERFORM set_config('together.wallet_user_id',COALESCE(previous_wallet_user,''),true);
  RETURN jsonb_build_object('ok',true,'status',p_status,'amount',w.amount,'withdrawal_id',w.id,'user_id',p_user_id);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('together.admin_withdrawals_access',COALESCE(previous_withdrawal_access,''),true);
  PERFORM set_config('together.wallet_user_id',COALESCE(previous_wallet_user,''),true);
  RAISE;
END;
$$;