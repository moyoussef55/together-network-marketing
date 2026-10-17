CREATE TABLE network_sales_qualification (
  marketer_id text PRIMARY KEY REFERENCES app_profiles(id) ON DELETE CASCADE,
  qualified_sales integer NOT NULL DEFAULT 0 CHECK (qualified_sales >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX network_sales_qualification_sales_idx ON network_sales_qualification(qualified_sales DESC);

-- Three completely independent binary-balance accounts for every marketer.
CREATE TABLE IF NOT EXISTS network_balance_accounts (
  marketer_id text NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
  position_no integer NOT NULL CHECK (position_no BETWEEN 1 AND 3),
  left_sales integer NOT NULL DEFAULT 0 CHECK (left_sales >= 0),
  right_sales integer NOT NULL DEFAULT 0 CHECK (right_sales >= 0),
  paid_checks numeric(12,2) NOT NULL DEFAULT 0 CHECK (paid_checks >= 0),
  PRIMARY KEY (marketer_id, position_no)
);

CREATE TABLE IF NOT EXISTS network_balance_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  marketer_id text NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
  position_no integer NOT NULL CHECK (position_no BETWEEN 1 AND 3),
  level_units integer NOT NULL CHECK (level_units IN (3,6,9,12,15,18,21)),
  check_amount numeric(12,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (marketer_id, position_no, level_units)
);

CREATE TABLE IF NOT EXISTS network_direct_commissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  marketer_id text NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount numeric(12,2) NOT NULL DEFAULT 250,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (marketer_id, order_id)
);

CREATE INDEX IF NOT EXISTS network_balance_checks_marketer_idx
  ON network_balance_checks(marketer_id, position_no, created_at DESC);