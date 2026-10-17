CREATE TABLE IF NOT EXISTS network_auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS network_auth_sessions_user_id_idx ON network_auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS network_auth_sessions_expires_at_idx ON network_auth_sessions(expires_at);