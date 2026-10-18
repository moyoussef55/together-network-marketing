-- Submit a marketer withdrawal using the authenticated custom-network identity.
-- Hatchable's own-row policy normally reads hatchable.user_id; custom network
-- sessions are validated in the API, then this function scopes the insert for this call.
CREATE OR REPLACE FUNCTION submit_network_withdrawal(
  p_user_id text,
  p_amount numeric,
  p_full_name text,
  p_transfer_phone text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  previous_hatchable_user text;
  inserted_row record;
BEGIN
  IF COALESCE(p_user_id,'') = '' OR COALESCE(p_amount,0) <= 0 THEN
    RAISE EXCEPTION 'invalid_withdrawal_request';
  END IF;

  previous_hatchable_user := current_setting('hatchable.user_id',true);
  PERFORM set_config('hatchable.user_id',p_user_id,true);

  INSERT INTO withdrawal_requests(user_id,amount,status,note,full_name,transfer_phone)
  VALUES(p_user_id,p_amount,'pending',NULL,p_full_name,p_transfer_phone)
  RETURNING id,amount,status,full_name,transfer_phone,created_at INTO inserted_row;

  PERFORM set_config('hatchable.user_id',COALESCE(previous_hatchable_user,''),true);
  RETURN to_jsonb(inserted_row);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('hatchable.user_id',COALESCE(previous_hatchable_user,''),true);
  RAISE;
END;
$$;