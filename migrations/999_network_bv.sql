CREATE TABLE IF NOT EXISTS network_bv_ledger (
  id BIGSERIAL PRIMARY KEY,
  order_id TEXT NOT NULL,
  source_member_id TEXT NOT NULL,
  upline_member_id TEXT NOT NULL,
  account_position INTEGER NOT NULL CHECK (account_position IN (1,2,3)),
  side TEXT NOT NULL CHECK (side IN ('left','right')),
  bv INTEGER NOT NULL DEFAULT 1000 CHECK (bv > 0),
  sale_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id, upline_member_id, account_position, side)
);

CREATE INDEX IF NOT EXISTS idx_network_bv_ledger_upline
  ON network_bv_ledger(upline_member_id, account_position, side, sale_at);

CREATE INDEX IF NOT EXISTS idx_network_bv_ledger_order
  ON network_bv_ledger(order_id);

CREATE TABLE IF NOT EXISTS network_bv_balances (
  member_id TEXT NOT NULL,
  account_position INTEGER NOT NULL CHECK (account_position IN (1,2,3)),
  total_right BIGINT NOT NULL DEFAULT 0,
  total_left BIGINT NOT NULL DEFAULT 0,
  carry_right BIGINT NOT NULL DEFAULT 0,
  carry_left BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, account_position)
);

CREATE TABLE IF NOT EXISTS network_bv_settlements (
  id BIGSERIAL PRIMARY KEY,
  member_id TEXT NOT NULL,
  account_position INTEGER NOT NULL CHECK (account_position IN (1,2,3)),
  week_start DATE NOT NULL,
  week_end DATE NOT NULL,
  right_bv BIGINT NOT NULL DEFAULT 0,
  left_bv BIGINT NOT NULL DEFAULT 0,
  matched_bv BIGINT NOT NULL DEFAULT 0,
  check_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  carry_right BIGINT NOT NULL DEFAULT 0,
  carry_left BIGINT NOT NULL DEFAULT 0,
  settled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (member_id, account_position, week_start, week_end)
);

CREATE INDEX IF NOT EXISTS idx_network_bv_settlements_member
  ON network_bv_settlements(member_id, account_position, settled_at DESC);