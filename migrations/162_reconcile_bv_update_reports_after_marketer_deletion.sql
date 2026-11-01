-- Keep historical BV update reports aligned with the live recalculated
-- settlements after test/deleted marketers are removed. Payout amounts are immutable.
CREATE TABLE IF NOT EXISTS network_bv_update_report_rows_deleted_bv_archive AS
SELECT * FROM network_bv_update_report_rows WHERE false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_name='network_bv_update_report_rows_deleted_bv_archive'
       AND constraint_type='PRIMARY KEY'
  ) THEN
    ALTER TABLE network_bv_update_report_rows_deleted_bv_archive
      ADD PRIMARY KEY(update_run_id,account_position,member_id);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION admin_refresh_network_bv_update_reports(p_marketer_id text DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app_a8bd59e089a78f6d
AS $$
DECLARE
  v_rows integer := 0;
BEGIN
  -- One-time recovery copy of affected report rows before their BV fields change.
  INSERT INTO network_bv_update_report_rows_deleted_bv_archive
  SELECT rr.*
    FROM network_bv_update_report_rows rr
    JOIN network_bv_update_runs r ON r.id=rr.update_run_id
    JOIN network_bv_settlements s
      ON s.member_id=rr.member_id
     AND s.account_position=rr.account_position
     AND s.week_start=r.week_start
     AND s.week_end=r.week_end
   WHERE EXISTS (
     SELECT 1
       FROM network_bv_deletion_archive a
       JOIN app_profiles u ON u.id=a.payload->>'upline_member_id'
                           AND u.deleted_at IS NULL
      WHERE a.record_type='ledger'
        AND (p_marketer_id IS NULL OR a.marketer_id=p_marketer_id)
        AND a.payload->>'upline_member_id'=rr.member_id
        AND (a.payload->>'account_position')::integer=rr.account_position
   )
  ON CONFLICT(update_run_id,account_position,member_id) DO NOTHING;

  UPDATE network_bv_update_report_rows rr
     SET right_bv_before=s.right_bv,
         left_bv_before=s.left_bv,
         matched_bv=s.matched_bv,
         carry_right_after=s.carry_right,
         carry_left_after=s.carry_left
    FROM network_bv_update_runs r,
         network_bv_settlements s
   WHERE r.id=rr.update_run_id
     AND s.member_id=rr.member_id
     AND s.account_position=rr.account_position
     AND s.week_start=r.week_start
     AND s.week_end=r.week_end
     AND EXISTS (
       SELECT 1
         FROM network_bv_deletion_archive a
         JOIN app_profiles u ON u.id=a.payload->>'upline_member_id'
                             AND u.deleted_at IS NULL
        WHERE a.record_type='ledger'
          AND (p_marketer_id IS NULL OR a.marketer_id=p_marketer_id)
          AND a.payload->>'upline_member_id'=rr.member_id
          AND (a.payload->>'account_position')::integer=rr.account_position
     );

  GET DIAGNOSTICS v_rows=ROW_COUNT;
  RETURN v_rows;
END;
$$;