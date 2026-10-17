ALTER TABLE member_messages ADD COLUMN IF NOT EXISTS media_key text;
ALTER TABLE member_messages ADD COLUMN IF NOT EXISTS media_type text;
ALTER TABLE member_messages ADD COLUMN IF NOT EXISTS show_in_site boolean NOT NULL DEFAULT true;
ALTER TABLE member_messages ADD COLUMN IF NOT EXISTS send_push boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS member_messages_site_visible_idx ON member_messages(recipient_id, created_at DESC) WHERE show_in_site = true;