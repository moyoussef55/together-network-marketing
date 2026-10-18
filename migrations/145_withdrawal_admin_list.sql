CREATE OR REPLACE FUNCTION list_network_withdrawals_admin()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = app_a8bd59e089a78f6d, public
AS $$
  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC),'[]'::jsonb)
  FROM (
    SELECT w.id,w.user_id,w.amount,w.status,w.note,w.full_name,w.transfer_phone,w.created_at,
           a.display_name,a.email,a.phone AS marketer_phone,a.referral_code,a.status AS marketer_status
      FROM withdrawal_requests w
      LEFT JOIN app_profiles a ON a.id=w.user_id
     ORDER BY w.created_at DESC
     LIMIT 1000
  ) x
$$;

CREATE OR REPLACE FUNCTION get_network_withdrawal_requests(p_user_id text)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = app_a8bd59e089a78f6d, public
AS $$
  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC),'[]'::jsonb)
  FROM (
    SELECT id,amount,status,note,full_name,transfer_phone,created_at
      FROM withdrawal_requests
     WHERE user_id=p_user_id
     ORDER BY created_at DESC
     LIMIT 100
  ) x
$$;