CREATE TABLE IF NOT EXISTS admin_auto_update_notifications (
  id BIGSERIAL PRIMARY KEY,
  week_start DATE NOT NULL,
  week_end DATE NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dismissed_at TIMESTAMPTZ,
  CONSTRAINT admin_auto_update_notifications_week_unique UNIQUE (week_start, week_end)
);
CREATE INDEX IF NOT EXISTS admin_auto_update_notifications_pending_idx
  ON admin_auto_update_notifications (created_at DESC)
  WHERE dismissed_at IS NULL;