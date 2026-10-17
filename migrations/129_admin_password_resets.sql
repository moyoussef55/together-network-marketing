CREATE TABLE IF NOT EXISTS network_admin_password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS network_admin_password_resets_created_idx ON network_admin_password_resets(created_at);
CREATE INDEX IF NOT EXISTS network_admin_password_resets_expires_idx ON network_admin_password_resets(expires_at);