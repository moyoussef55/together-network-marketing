-- Immutable per-run snapshots for weekly/manual cheque reports.
-- Existing network_bv_settlements keeps only the latest values per member/account/week;
-- these tables preserve the exact result of each update execution separately.
CREATE TABLE IF NOT EXISTS network_bv_update_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  update_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  update_type text NOT NULL CHECK (update_type IN ('manual','automatic')),
  week_start date NOT NULL,
  week_end date NOT NULL,
  allocated_rows integer NOT NULL DEFAULT 0,
  accounts_count integer NOT NULL DEFAULT 0,
  check_rows integer NOT NULL DEFAULT 0,
  check_rate numeric(12,2) NOT NULL DEFAULT 1500,
  direct_commissions_released integer NOT NULL DEFAULT 0,
  cheque_marketers integer NOT NULL DEFAULT 0,
  total_cheque_amount numeric(14,2) NOT NULL DEFAULT 0,
  report_rows integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS network_bv_update_runs_update_at_idx
  ON network_bv_update_runs(update_at DESC);

CREATE TABLE IF NOT EXISTS network_bv_update_report_rows (
  update_run_id uuid NOT NULL REFERENCES network_bv_update_runs(id) ON DELETE CASCADE,
  member_id text NOT NULL,
  account_position integer NOT NULL CHECK (account_position IN (1,2,3)),
  right_bv_before bigint NOT NULL DEFAULT 0,
  left_bv_before bigint NOT NULL DEFAULT 0,
  matched_bv bigint NOT NULL DEFAULT 0,
  carry_right_after bigint NOT NULL DEFAULT 0,
  carry_left_after bigint NOT NULL DEFAULT 0,
  check_amount numeric(12,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (update_run_id, member_id, account_position)
);

CREATE INDEX IF NOT EXISTS network_bv_update_report_rows_run_check_idx
  ON network_bv_update_report_rows(update_run_id, check_amount DESC);

CREATE INDEX IF NOT EXISTS network_bv_update_report_rows_member_idx
  ON network_bv_update_report_rows(member_id, update_run_id);

CREATE OR REPLACE FUNCTION record_network_bv_update_report(
  p_update_type text,
  p_week_start date,
  p_week_end date,
  p_allocated_rows integer DEFAULT 0,
  p_accounts_count integer DEFAULT 0,
  p_check_rows integer DEFAULT 0,
  p_check_rate numeric DEFAULT 1500,
  p_direct_commissions_released integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_run_id uuid := gen_random_uuid();
  v_report_rows integer := 0;
  v_cheque_marketers integer := 0;
  v_total_cheque_amount numeric(14,2) := 0;
  v_update_at timestamptz := clock_timestamp();
BEGIN
  IF p_update_type NOT IN ('manual','automatic') THEN
    RAISE EXCEPTION 'invalid_update_type';
  END IF;
  IF p_week_start IS NULL OR p_week_end IS NULL OR p_week_end <= p_week_start THEN
    RAISE EXCEPTION 'invalid_update_period';
  END IF;

  INSERT INTO network_bv_update_runs(
    id,update_at,update_type,week_start,week_end,allocated_rows,accounts_count,
    check_rows,check_rate,direct_commissions_released
  ) VALUES (
    v_run_id,v_update_at,p_update_type,p_week_start,p_week_end,
    GREATEST(COALESCE(p_allocated_rows,0),0),
    GREATEST(COALESCE(p_accounts_count,0),0),
    GREATEST(COALESCE(p_check_rows,0),0),
    GREATEST(COALESCE(p_check_rate,1500),0),
    GREATEST(COALESCE(p_direct_commissions_released,0),0)
  );

  INSERT INTO network_bv_update_report_rows(
    update_run_id,member_id,account_position,right_bv_before,left_bv_before,
    matched_bv,carry_right_after,carry_left_after,check_amount
  )
  SELECT v_run_id,s.member_id::text,s.account_position,
         COALESCE(s.right_bv,0),COALESCE(s.left_bv,0),COALESCE(s.matched_bv,0),
         COALESCE(s.carry_right,0),COALESCE(s.carry_left,0),COALESCE(s.check_amount,0)
    FROM network_bv_settlements s
   WHERE s.week_start=p_week_start AND s.week_end=p_week_end
  ON CONFLICT(update_run_id,member_id,account_position) DO UPDATE SET
    right_bv_before=EXCLUDED.right_bv_before,
    left_bv_before=EXCLUDED.left_bv_before,
    matched_bv=EXCLUDED.matched_bv,
    carry_right_after=EXCLUDED.carry_right_after,
    carry_left_after=EXCLUDED.carry_left_after,
    check_amount=EXCLUDED.check_amount;

  SELECT COUNT(*)::int,COALESCE(SUM(check_amount),0)::numeric(14,2)
    INTO v_report_rows,v_total_cheque_amount
    FROM network_bv_update_report_rows
   WHERE update_run_id=v_run_id;

  SELECT COUNT(*)::int
    INTO v_cheque_marketers
    FROM (
      SELECT member_id
        FROM network_bv_update_report_rows
       WHERE update_run_id=v_run_id
       GROUP BY member_id
      HAVING SUM(check_amount)>0
    ) paid;

  UPDATE network_bv_update_runs
     SET report_rows=v_report_rows,
         cheque_marketers=v_cheque_marketers,
         total_cheque_amount=v_total_cheque_amount
   WHERE id=v_run_id;

  RETURN jsonb_build_object(
    'id',v_run_id,
    'update_at',v_update_at,
    'update_type',p_update_type,
    'week_start',p_week_start,
    'week_end',p_week_end,
    'report_rows',v_report_rows,
    'cheque_marketers',v_cheque_marketers,
    'total_cheque_amount',v_total_cheque_amount
  );
END;
$$;