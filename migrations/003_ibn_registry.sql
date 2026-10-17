CREATE TABLE IF NOT EXISTS network_ibns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  amount numeric(12,2) NOT NULL,
  quantity integer NOT NULL DEFAULT 1,
  expires_at timestamptz NOT NULL,
  used_count integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE network_ibns ADD COLUMN IF NOT EXISTS created_by_id text;
ALTER TABLE network_ibns ADD COLUMN IF NOT EXISTS used_by_upline_id text;
ALTER TABLE network_ibns ADD COLUMN IF NOT EXISTS registered_agent_id text;
ALTER TABLE network_ibns ADD COLUMN IF NOT EXISTS used_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS network_ibns_code_uidx ON network_ibns(code);
CREATE INDEX IF NOT EXISTS network_ibns_created_idx ON network_ibns(created_at DESC);
CREATE INDEX IF NOT EXISTS network_ibns_used_upline_idx ON network_ibns(used_by_upline_id);