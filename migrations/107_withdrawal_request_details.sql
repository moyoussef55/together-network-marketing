ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS full_name text;
ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS transfer_phone text;
CREATE INDEX IF NOT EXISTS withdrawal_requests_user_status_created_idx ON withdrawal_requests(user_id,status,created_at DESC);