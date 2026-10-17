CREATE TABLE IF NOT EXISTS marketer_password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS marketer_password_resets_user_created_idx ON marketer_password_resets(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS marketer_password_resets_expiry_idx ON marketer_password_resets(expires_at);