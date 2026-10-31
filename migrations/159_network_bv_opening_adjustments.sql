-- Store lifetime BV imported from the source separately from actual sales.
CREATE TABLE IF NOT EXISTS network_bv_opening_adjustments (
  member_id text NOT NULL,
  account_position integer NOT NULL CHECK (account_position IN (1,2,3)),
  adjustment_right bigint NOT NULL DEFAULT 0,
  adjustment_left bigint NOT NULL DEFAULT 0,
  source_total_right bigint NOT NULL DEFAULT 0,
  source_total_left bigint NOT NULL DEFAULT 0,
  source_carry_right bigint NOT NULL DEFAULT 0,
  source_carry_left bigint NOT NULL DEFAULT 0,
  source_updated_at timestamptz,
  source_upload_id uuid NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, account_position)
);

CREATE TABLE IF NOT EXISTS legacy_import_record_map (
  collection_name text NOT NULL,
  source_id text NOT NULL,
  target_table text NOT NULL,
  target_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_name, source_id)
);