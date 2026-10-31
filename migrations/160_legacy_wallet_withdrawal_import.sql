-- Import legacy wallet history and withdrawals through narrow SECURITY DEFINER helpers.
CREATE UNIQUE INDEX IF NOT EXISTS wallet_transactions_legacy_balance_ref_uq
  ON wallet_transactions(user_id, reference)
  WHERE reference LIKE 'legacy-balance:%';
CREATE OR REPLACE FUNCTION import_legacy_wallet_history(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO app_a8bd59e089a78f6d
AS $function$
DECLARE
  r record;
  previous_hatchable text;
  previous_wallet text;
  affected integer;
  inserted_count integer := 0;
BEGIN
  previous_hatchable := current_setting('hatchable.user_id',true);
  previous_wallet := current_setting('together.wallet_user_id',true);
  FOR r IN
    SELECT * FROM jsonb_to_recordset(COALESCE(p_rows,'[]'::jsonb))
      AS x(user_id text,transaction_type text,amount numeric,reference text,created_at timestamptz)
  LOOP
    IF COALESCE(r.user_id,'')='' OR COALESCE(r.reference,'')='' OR NOT EXISTS(
      SELECT 1 FROM app_profiles p WHERE p.id=r.user_id AND p.role='marketer'
    ) THEN
      CONTINUE;
    END IF;
    PERFORM set_config('hatchable.user_id',r.user_id,true);
    PERFORM set_config('together.wallet_user_id',r.user_id,true);
    INSERT INTO wallet_transactions(user_id,type,amount,reference,created_at)
    VALUES(r.user_id,COALESCE(NULLIF(r.transaction_type,''),'legacy_history'),
           COALESCE(r.amount,0),r.reference,COALESCE(r.created_at,now()))
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS affected = ROW_COUNT;
    inserted_count := inserted_count + affected;
  END LOOP;
  PERFORM set_config('hatchable.user_id',COALESCE(previous_hatchable,''),true);
  PERFORM set_config('together.wallet_user_id',COALESCE(previous_wallet,''),true);
  RETURN inserted_count;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('hatchable.user_id',COALESCE(previous_hatchable,''),true);
  PERFORM set_config('together.wallet_user_id',COALESCE(previous_wallet,''),true);
  RAISE;
END;
$function$;

CREATE OR REPLACE FUNCTION import_legacy_withdrawal_requests(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO app_a8bd59e089a78f6d
AS $function$
DECLARE
  r record;
  previous_hatchable text;
  previous_wallet text;
  affected integer;
  inserted_count integer := 0;
BEGIN
  previous_hatchable := current_setting('hatchable.user_id',true);
  previous_wallet := current_setting('together.wallet_user_id',true);
  FOR r IN
    SELECT * FROM jsonb_to_recordset(COALESCE(p_rows,'[]'::jsonb))
      AS x(id text,user_id text,amount numeric,status text,note text,created_at timestamptz,
           full_name text,transfer_phone text)
  LOOP
    IF COALESCE(r.id,'')='' OR COALESCE(r.user_id,'')='' OR COALESCE(r.amount,0)<=0 OR NOT EXISTS(
      SELECT 1 FROM app_profiles p WHERE p.id=r.user_id AND p.role='marketer'
    ) THEN
      CONTINUE;
    END IF;
    PERFORM set_config('hatchable.user_id',r.user_id,true);
    PERFORM set_config('together.wallet_user_id',r.user_id,true);
    INSERT INTO withdrawal_requests(id,user_id,amount,status,note,created_at,full_name,transfer_phone)
    VALUES(r.id::uuid,r.user_id,ABS(r.amount),
      CASE WHEN lower(COALESCE(r.status,'')) IN ('pending','completed','rejected')
           THEN lower(r.status) ELSE 'pending' END,
      r.note,COALESCE(r.created_at,now()),r.full_name,r.transfer_phone)
    ON CONFLICT(id) DO NOTHING;
    GET DIAGNOSTICS affected = ROW_COUNT;
    inserted_count := inserted_count + affected;
  END LOOP;
  PERFORM set_config('hatchable.user_id',COALESCE(previous_hatchable,''),true);
  PERFORM set_config('together.wallet_user_id',COALESCE(previous_wallet,''),true);
  RETURN inserted_count;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('hatchable.user_id',COALESCE(previous_hatchable,''),true);
  PERFORM set_config('together.wallet_user_id',COALESCE(previous_wallet,''),true);
  RAISE;
END;
$function$;