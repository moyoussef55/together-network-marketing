ALTER TABLE network_agent_applications ADD COLUMN IF NOT EXISTS welcome_email_status text NOT NULL DEFAULT 'not_sent';
ALTER TABLE network_agent_applications ADD COLUMN IF NOT EXISTS welcome_email_sent_at timestamptz;
ALTER TABLE network_agent_applications ADD COLUMN IF NOT EXISTS welcome_email_error text;

CREATE TABLE IF NOT EXISTS agent_document_access_tokens (
  id bigserial PRIMARY KEY,
  application_id uuid NOT NULL,
  media_kind text NOT NULL,
  storage_key text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_agent_document_access_tokens_application ON agent_document_access_tokens(application_id);