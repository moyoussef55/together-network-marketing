-- Security hardening: bound bearer document links and persistent sessions.
-- Existing document links receive a 30-day grace period from this migration.
ALTER TABLE agent_document_access_tokens
  ADD COLUMN IF NOT EXISTS expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days');

CREATE INDEX IF NOT EXISTS idx_agent_document_access_tokens_expiry
  ON agent_document_access_tokens(expires_at);

-- Shorten already-issued persistent sessions without logging everyone out immediately.
UPDATE network_admin_sessions
   SET expires_at = LEAST(expires_at, now() + interval '30 days')
 WHERE expires_at > now() + interval '30 days';

UPDATE network_auth_sessions
   SET expires_at = LEAST(expires_at, now() + interval '30 days')
 WHERE expires_at > now() + interval '30 days';