ALTER TABLE network_events ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '';
ALTER TABLE network_events ADD COLUMN IF NOT EXISTS event_type TEXT NOT NULL DEFAULT 'past';
ALTER TABLE network_events ADD COLUMN IF NOT EXISTS event_date TIMESTAMPTZ;
ALTER TABLE network_events ADD COLUMN IF NOT EXISTS is_visible BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE network_events ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'members';
ALTER TABLE network_events ADD COLUMN IF NOT EXISTS section_title TEXT NOT NULL DEFAULT '';
UPDATE network_events SET title=LEFT(description,120) WHERE title='';
CREATE INDEX IF NOT EXISTS network_events_visibility_idx ON network_events(is_visible,audience,event_type,created_at DESC);