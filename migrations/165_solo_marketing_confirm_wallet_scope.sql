CREATE OR REPLACE FUNCTION confirm_solo_marketing_order(p_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
DECLARE
  v_order solo_marketing_orders%ROWTYPE;
  v_tx uuid;
  v_balance numeric(12,2);
  old_hatchable_user text;
  old_wallet_user text;
  v_credited boolean := false;
BEGIN
  SELECT * INTO v_order
    FROM solo_marketing_orders
   WHERE id=p_order_id AND deleted_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found'; END IF;

  old_hatchable_user := current_setting('hatchable.user_id',true);
  old_wallet_user := current_setting('together.wallet_user_id',true);
  PERFORM set_config('hatchable.user_id',v_order.marketer_id,true);
  PERFORM set_config('together.wallet_user_id',v_order.marketer_id,true);

  IF v_order.commission_credited_at IS NOT NULL THEN
    SELECT balance INTO v_balance FROM wallets WHERE user_id=v_order.marketer_id;
    PERFORM set_config('hatchable.user_id',COALESCE(old_hatchable_user,''),true);
    PERFORM set_config('together.wallet_user_id',COALESCE(old_wallet_user,''),true);
    RETURN jsonb_build_object('ok',true,'already_confirmed',true,'credited',false,
      'commission',v_order.commission,'balance',COALESCE(v_balance,0),'order_code',v_order.order_code);
  END IF;

  IF v_order.commission > 0 THEN
    INSERT INTO wallet_transactions(user_id,type,amount,reference)
    VALUES(v_order.marketer_id,'solo_marketing_commission',v_order.commission,'solo-marketing:'||v_order.order_code)
    ON CONFLICT(user_id,reference) WHERE reference LIKE 'solo-marketing:%'
    DO NOTHING
    RETURNING id INTO v_tx;

    IF v_tx IS NOT NULL THEN
      INSERT INTO wallets(user_id,balance)
      VALUES(v_order.marketer_id,v_order.commission)
      ON CONFLICT(user_id) DO UPDATE
        SET balance=wallets.balance+EXCLUDED.balance,updated_at=now();
      v_credited := true;
    END IF;
  END IF;

  UPDATE solo_marketing_orders
     SET confirmed_at=now(),commission_credited_at=now(),
         status='تم تأكيد الطلب',updated_at=now()
   WHERE id=p_order_id;

  SELECT balance INTO v_balance FROM wallets WHERE user_id=v_order.marketer_id;
  PERFORM set_config('hatchable.user_id',COALESCE(old_hatchable_user,''),true);
  PERFORM set_config('together.wallet_user_id',COALESCE(old_wallet_user,''),true);

  RETURN jsonb_build_object('ok',true,'already_confirmed',false,'credited',v_credited,
    'commission',v_order.commission,'balance',COALESCE(v_balance,0),'order_code',v_order.order_code);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('hatchable.user_id',COALESCE(old_hatchable_user,''),true);
  PERFORM set_config('together.wallet_user_id',COALESCE(old_wallet_user,''),true);
  RAISE;
END;
$function$;