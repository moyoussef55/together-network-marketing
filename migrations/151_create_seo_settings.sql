CREATE TABLE IF NOT EXISTS seo_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO seo_settings (id, settings)
VALUES (1, '{}'::jsonb)
ON CONFLICT (id) DO NOTHING;