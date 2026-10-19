-- Permit the already-authenticated admin withdrawals endpoint to read the queue,
-- without broadening ordinary members' own-row access.
DROP POLICY IF EXISTS together_admin_withdrawal_queue_read ON withdrawal_requests;
CREATE POLICY together_admin_withdrawal_queue_read
ON withdrawal_requests
FOR SELECT
USING (current_setting('together.admin_withdrawals_access', true) = 'true');

CREATE OR REPLACE FUNCTION list_network_withdrawals_admin()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app_a8bd59e089a78f6d, public
AS $$
DECLARE
  previous_flag text;
  result_rows jsonb;
BEGIN
  previous_flag := current_setting('together.admin_withdrawals_access',true);
  PERFORM set_config('together.admin_withdrawals_access','true',true);
  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC),'[]'::jsonb)
    INTO result_rows
    FROM (
      SELECT w.id,w.user_id,w.amount,w.status,w.note,w.full_name,w.transfer_phone,w.created_at,
             a.display_name,a.email,a.phone AS marketer_phone,a.referral_code,a.status AS marketer_status
        FROM withdrawal_requests w
        LEFT JOIN app_profiles a ON a.id=w.user_id
       ORDER BY w.created_at DESC
       LIMIT 1000
    ) x;
  PERFORM set_config('together.admin_withdrawals_access',COALESCE(previous_flag,''),true);
  RETURN result_rows;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('together.admin_withdrawals_access',COALESCE(previous_flag,''),true);
  RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION get_network_withdrawal_requests(p_user_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app_a8bd59e089a78f6d, public
AS $$
DECLARE
  previous_user text;
  result_rows jsonb;
BEGIN
  IF COALESCE(p_user_id,'') = '' THEN RETURN '[]'::jsonb; END IF;
  previous_user := current_setting('hatchable.user_id',true);
  PERFORM set_config('hatchable.user_id',p_user_id,true);
  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC),'[]'::jsonb)
    INTO result_rows
    FROM (
      SELECT id,amount,status,note,full_name,transfer_phone,created_at
        FROM withdrawal_requests
       WHERE user_id=p_user_id
       ORDER BY created_at DESC
       LIMIT 100
    ) x;
  PERFORM set_config('hatchable.user_id',COALESCE(previous_user,''),true);
  RETURN result_rows;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('hatchable.user_id',COALESCE(previous_user,''),true);
  RAISE;
END;
$$;