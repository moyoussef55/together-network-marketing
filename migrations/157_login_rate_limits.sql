-- Privacy-preserving database-backed rate limits for public password-login endpoints.
CREATE TABLE IF NOT EXISTS network_login_rate_limits (
  bucket_key text PRIMARY KEY,
  attempts integer NOT NULL DEFAULT 0,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS network_login_rate_limits_updated_idx
  ON network_login_rate_limits(updated_at);