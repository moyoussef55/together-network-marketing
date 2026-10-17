CREATE TABLE IF NOT EXISTS network_event_media (
 id BIGSERIAL PRIMARY KEY,
 event_id BIGINT NOT NULL REFERENCES network_events(id) ON DELETE CASCADE,
 media_key TEXT NOT NULL,
 media_type TEXT NOT NULL,
 media_name TEXT NOT NULL,
 media_bytes BIGINT NOT NULL DEFAULT 0,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS network_event_media_event_idx ON network_event_media(event_id,id);