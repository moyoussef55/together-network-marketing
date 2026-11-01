CREATE OR REPLACE FUNCTION get_solo_marketing_commission_state(p_user_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
DECLARE
  v_total numeric(14,2);
  v_count integer;
  v_rows jsonb;
  old_hatchable_user text;
  old_wallet_user text;
BEGIN
  IF COALESCE(btrim(p_user_id),'')='' OR NOT EXISTS (
    SELECT 1 FROM app_profiles
     WHERE id=p_user_id AND role='marketer' AND deleted_at IS NULL
       AND login_blocked=false AND status NOT IN ('blocked','deleted')
  ) THEN
    RAISE EXCEPTION 'marketer_not_found';
  END IF;

  -- wallet_transactions is protected by user-scoped policies. Match the
  -- established wallet-state helper's transaction-local identity context.
  old_hatchable_user := current_setting('hatchable.user_id',true);
  old_wallet_user := current_setting('together.wallet_user_id',true);
  PERFORM set_config('hatchable.user_id',p_user_id,true);
  PERFORM set_config('together.wallet_user_id',p_user_id,true);

  SELECT COALESCE(SUM(amount),0)::numeric(14,2),COUNT(*)::integer
    INTO v_total,v_count
    FROM wallet_transactions
   WHERE user_id=p_user_id
     AND type='solo_marketing_commission'
     AND reference LIKE 'solo-marketing:%'
     AND amount>0;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id',recent.id,
      'type',recent.type,
      'amount',recent.amount,
      'reference',recent.reference,
      'created_at',recent.created_at
    ) ORDER BY recent.created_at DESC),'[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT id,type,amount,reference,created_at
        FROM wallet_transactions
       WHERE user_id=p_user_id
         AND type='solo_marketing_commission'
         AND reference LIKE 'solo-marketing:%'
         AND amount>0
       ORDER BY created_at DESC
       LIMIT 500
    ) recent;

  PERFORM set_config('hatchable.user_id',COALESCE(old_hatchable_user,''),true);
  PERFORM set_config('together.wallet_user_id',COALESCE(old_wallet_user,''),true);

  RETURN jsonb_build_object(
    'total',COALESCE(v_total,0),
    'count',COALESCE(v_count,0),
    'transactions',COALESCE(v_rows,'[]'::jsonb)
  );
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('hatchable.user_id',COALESCE(old_hatchable_user,''),true);
  PERFORM set_config('together.wallet_user_id',COALESCE(old_wallet_user,''),true);
  RAISE;
END;
$function$;