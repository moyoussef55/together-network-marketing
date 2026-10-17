ALTER TABLE network_bv_settlements
  ADD COLUMN IF NOT EXISTS is_finalized boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS network_bv_settlements_week_finalized_idx
  ON network_bv_settlements(week_end,is_finalized);