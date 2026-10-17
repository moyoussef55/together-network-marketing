CREATE TABLE IF NOT EXISTS member_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id text NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
  sender_id text,
  subject text NOT NULL DEFAULT '',
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
CREATE INDEX IF NOT EXISTS member_messages_recipient_created_idx ON member_messages(recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS member_messages_unread_idx ON member_messages(recipient_id) WHERE read_at IS NULL;