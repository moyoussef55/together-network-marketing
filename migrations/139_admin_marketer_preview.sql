CREATE TABLE IF NOT EXISTS admin_marketer_preview_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  admin_session_hash text NOT NULL,
  marketer_id text NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_marketer_preview_expiry_idx ON admin_marketer_preview_sessions(expires_at);
CREATE INDEX IF NOT EXISTS admin_marketer_preview_marketer_idx ON admin_marketer_preview_sessions(marketer_id);