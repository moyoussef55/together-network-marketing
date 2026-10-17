ALTER TABLE app_profiles ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE app_profiles ADD COLUMN IF NOT EXISTS theme_mode text NOT NULL DEFAULT 'dark';
ALTER TABLE app_profiles ADD COLUMN IF NOT EXISTS theme_primary_color text NOT NULL DEFAULT '#42d6a4';
ALTER TABLE app_profiles ADD COLUMN IF NOT EXISTS theme_button_color text NOT NULL DEFAULT '#1683ff';
ALTER TABLE app_profiles ADD COLUMN IF NOT EXISTS theme_text_color text NOT NULL DEFAULT '#f5f7fb';
ALTER TABLE app_profiles ADD COLUMN IF NOT EXISTS theme_bg_color text NOT NULL DEFAULT '#071426';