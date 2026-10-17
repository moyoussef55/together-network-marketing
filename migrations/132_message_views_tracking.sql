ALTER TABLE member_messages ADD COLUMN IF NOT EXISTS batch_id uuid;
ALTER TABLE member_messages ADD COLUMN IF NOT EXISTS viewed_at timestamptz;
UPDATE member_messages SET batch_id = id WHERE batch_id IS NULL;
ALTER TABLE member_messages ALTER COLUMN batch_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS member_messages_batch_created_idx ON member_messages(batch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS member_messages_viewed_idx ON member_messages(batch_id, viewed_at) WHERE viewed_at IS NOT NULL;