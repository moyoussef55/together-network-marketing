CREATE TABLE IF NOT EXISTS marketer_support_messages (
  id BIGSERIAL PRIMARY KEY,
  marketer_id TEXT NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('marketer','admin')),
  sender_id TEXT,
  message TEXT NOT NULL CHECK (length(trim(message)) BETWEEN 1 AND 4000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS marketer_support_thread_idx ON marketer_support_messages(marketer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS marketer_support_unread_idx ON marketer_support_messages(created_at DESC) WHERE sender_role='marketer' AND read_at IS NULL;