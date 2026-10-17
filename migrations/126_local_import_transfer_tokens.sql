CREATE TABLE IF NOT EXISTS local_migration_access_tokens (
  token_hash text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS local_migration_access_tokens_expiry_idx ON local_migration_access_tokens(expires_at);