CREATE TABLE IF NOT EXISTS network_events (
  id BIGSERIAL PRIMARY KEY,
  description TEXT NOT NULL,
  media_key TEXT NOT NULL,
  media_type TEXT NOT NULL,
  media_name TEXT NOT NULL,
  media_bytes BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS network_events_created_at_idx ON network_events(created_at DESC);