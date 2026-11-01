-- Safely remove a marketer's BV contributions from the live network while
-- retaining an auditable, reversible copy. Placement edges are intentionally kept:
-- active descendants must still pass BV through a deleted intermediate node.
CREATE TABLE IF NOT EXISTS network_bv_deletion_archive (
  id bigserial PRIMARY KEY,
  marketer_id text NOT NULL,
  record_type text NOT NULL,
  record_id text NOT NULL,
  payload jsonb NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now(),
  restored_at timestamptz,
  UNIQUE(marketer_id,record_type,record_id)
);

CREATE OR REPLACE FUNCTION recalculate_network_bv_account(
  p_member_id text,
  p_account_position integer,
  p_initial_carry_right bigint,
  p_initial_carry_left bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app_a8bd59e089a78f6d
AS $$
DECLARE
  s record;
  v_period_right bigint;
  v_period_left bigint;
  v_right bigint;
  v_left bigint;
  v_matched bigint;
  v_carry_right bigint;
  v_carry_left bigint;
  v_had_settlement boolean := false;
BEGIN
  v_carry_right := COALESCE(p_initial_carry_right,0);
  v_carry_left := COALESCE(p_initial_carry_left,0);

  FOR s IN
    SELECT id,week_start,week_end
      FROM network_bv_settlements
     WHERE member_id=p_member_id AND account_position=p_account_position
     ORDER BY week_start,week_end,id
  LOOP
    SELECT COALESCE(SUM(l.bv) FILTER(WHERE l.side='right'),0)::bigint,
           COALESCE(SUM(l.bv) FILTER(WHERE l.side='left'),0)::bigint
      INTO v_period_right,v_period_left
      FROM network_bv_ledger l
     WHERE l.upline_member_id=p_member_id
       AND l.account_position=p_account_position
       AND l.sale_at >= (s.week_start::timestamp AT TIME ZONE 'Africa/Cairo')
       AND l.sale_at <  (s.week_end::timestamp AT TIME ZONE 'Africa/Cairo');

    v_right := v_carry_right + COALESCE(v_period_right,0);
    v_left := v_carry_left + COALESCE(v_period_left,0);
    v_matched := floor(LEAST(v_right,v_left)::numeric/3000)*3000;
    v_carry_right := CASE WHEN v_matched>=24000 THEN 0 ELSE v_right-v_matched END;
    v_carry_left := CASE WHEN v_matched>=24000 THEN 0 ELSE v_left-v_matched END;

    -- Preserve the historical payout amount and payout timestamp. Only BV-derived
    -- balances and carry are recomputed; no wallet credit/debit is performed here.
    UPDATE network_bv_settlements
       SET right_bv=v_right,
           left_bv=v_left,
           matched_bv=v_matched,
           carry_right=v_carry_right,
           carry_left=v_carry_left
     WHERE id=s.id;

    v_had_settlement := true;
  END LOOP;

  IF NOT v_had_settlement THEN
    SELECT COALESCE(carry_right,0),COALESCE(carry_left,0)
      INTO v_carry_right,v_carry_left
      FROM network_bv_balances
     WHERE member_id=p_member_id AND account_position=p_account_position;
    v_carry_right := COALESCE(v_carry_right,0);
    v_carry_left := COALESCE(v_carry_left,0);
  END IF;

  INSERT INTO network_bv_balances(
    member_id,account_position,total_right,total_left,carry_right,carry_left,updated_at
  )
  VALUES(
    p_member_id,p_account_position,
    COALESCE((SELECT SUM(l.bv) FROM network_bv_ledger l
      WHERE l.upline_member_id=p_member_id AND l.account_position=p_account_position AND l.side='right'),0)
      + COALESCE((SELECT SUM(a.adjustment_right) FROM network_bv_opening_adjustments a
        WHERE a.member_id=p_member_id AND a.account_position=p_account_position),0),
    COALESCE((SELECT SUM(l.bv) FROM network_bv_ledger l
      WHERE l.upline_member_id=p_member_id AND l.account_position=p_account_position AND l.side='left'),0)
      + COALESCE((SELECT SUM(a.adjustment_left) FROM network_bv_opening_adjustments a
        WHERE a.member_id=p_member_id AND a.account_position=p_account_position),0),
    v_carry_right,v_carry_left,now()
  )
  ON CONFLICT(member_id,account_position) DO UPDATE SET
    total_right=EXCLUDED.total_right,
    total_left=EXCLUDED.total_left,
    carry_right=EXCLUDED.carry_right,
    carry_left=EXCLUDED.carry_left,
    updated_at=now();

  RETURN jsonb_build_object('carry_right',v_carry_right,'carry_left',v_carry_left);
END;
$$;

CREATE OR REPLACE FUNCTION admin_delete_marketer_network_bv(p_marketer_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app_a8bd59e089a78f6d
AS $$
DECLARE
  v_profile app_profiles%ROWTYPE;
  a record;
  v_ledger_rows integer := 0;
  v_source_bv bigint := 0;
  v_upline_bv bigint := 0;
  v_accounts integer := 0;
  v_manual_rows integer := 0;
BEGIN
  SELECT * INTO v_profile FROM app_profiles
   WHERE id=p_marketer_id AND role='marketer'
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'error','marketer_not_found');
  END IF;

  IF EXISTS (
    SELECT 1 FROM network_bv_deletion_archive
     WHERE marketer_id=p_marketer_id AND record_type='processed' AND restored_at IS NULL
  ) THEN
    RETURN jsonb_build_object('ok',true,'already_processed',true);
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS _network_delete_bv_accounts (
    member_id text NOT NULL,
    account_position integer NOT NULL,
    initial_carry_right bigint NOT NULL,
    initial_carry_left bigint NOT NULL,
    had_settlements boolean NOT NULL,
    PRIMARY KEY(member_id,account_position)
  ) ON COMMIT DROP;
  TRUNCATE _network_delete_bv_accounts;

  -- Only active uplines receiving BV from this source need recalculation.
  -- Capture the original opening carry before removing the source ledger rows.
  INSERT INTO _network_delete_bv_accounts(
    member_id,account_position,initial_carry_right,initial_carry_left,had_settlements
  )
  WITH impacted AS (
    SELECT DISTINCT l.upline_member_id AS member_id,l.account_position
      FROM network_bv_ledger l
      JOIN app_profiles u ON u.id=l.upline_member_id AND u.deleted_at IS NULL
     WHERE l.source_member_id=p_marketer_id
       AND l.upline_member_id<>p_marketer_id
  )
  SELECT i.member_id,i.account_position,
         CASE WHEN first_s.id IS NULL THEN COALESCE(b.carry_right,0)
              ELSE first_s.right_bv-COALESCE(periods.period_right,0) END,
         CASE WHEN first_s.id IS NULL THEN COALESCE(b.carry_left,0)
              ELSE first_s.left_bv-COALESCE(periods.period_left,0) END,
         (first_s.id IS NOT NULL)
    FROM impacted i
    LEFT JOIN network_bv_balances b
      ON b.member_id=i.member_id AND b.account_position=i.account_position
    LEFT JOIN LATERAL (
      SELECT s.id,s.week_start,s.week_end,s.right_bv,s.left_bv
        FROM network_bv_settlements s
       WHERE s.member_id=i.member_id AND s.account_position=i.account_position
       ORDER BY s.week_start,s.week_end,s.id
       LIMIT 1
    ) first_s ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(l.bv) FILTER(WHERE l.side='right'),0)::bigint AS period_right,
             COALESCE(SUM(l.bv) FILTER(WHERE l.side='left'),0)::bigint AS period_left
        FROM network_bv_ledger l
       WHERE l.upline_member_id=i.member_id
         AND l.account_position=i.account_position
         AND first_s.id IS NOT NULL
         AND l.sale_at >= (first_s.week_start::timestamp AT TIME ZONE 'Africa/Cairo')
         AND l.sale_at <  (first_s.week_end::timestamp AT TIME ZONE 'Africa/Cairo')
    ) periods ON true;

  IF EXISTS (
    SELECT 1 FROM _network_delete_bv_accounts
     WHERE initial_carry_right<0 OR initial_carry_left<0
  ) THEN
    RETURN jsonb_build_object(
      'ok',false,'error','network_bv_baseline_inconsistent',
      'message','A BV opening carry is inconsistent; no delete was applied.'
    );
  END IF;

  -- Soft-delete the profile, but keep placement edges as routing links for any
  -- still-active descendants located below this marketer.
  UPDATE app_profiles
     SET deleted_at=COALESCE(deleted_at,now()),
         status='deleted'
   WHERE id=p_marketer_id AND role='marketer';

  SELECT count(*)::int,
         COALESCE(SUM(bv) FILTER(WHERE source_member_id=p_marketer_id),0)::bigint,
         COALESCE(SUM(bv) FILTER(WHERE upline_member_id=p_marketer_id),0)::bigint
    INTO v_ledger_rows,v_source_bv,v_upline_bv
    FROM network_bv_ledger
   WHERE source_member_id=p_marketer_id OR upline_member_id=p_marketer_id;

  INSERT INTO network_bv_deletion_archive(marketer_id,record_type,record_id,payload)
  SELECT p_marketer_id,'ledger',l.id::text,to_jsonb(l)
    FROM network_bv_ledger l
   WHERE l.source_member_id=p_marketer_id OR l.upline_member_id=p_marketer_id
  ON CONFLICT(marketer_id,record_type,record_id) DO UPDATE
    SET payload=EXCLUDED.payload,archived_at=now(),restored_at=NULL;

  INSERT INTO network_bv_deletion_archive(marketer_id,record_type,record_id,payload)
  SELECT p_marketer_id,'balance',b.member_id||':'||b.account_position::text,to_jsonb(b)
    FROM network_bv_balances b WHERE b.member_id=p_marketer_id
  ON CONFLICT(marketer_id,record_type,record_id) DO UPDATE
    SET payload=EXCLUDED.payload,archived_at=now(),restored_at=NULL;

  INSERT INTO network_bv_deletion_archive(marketer_id,record_type,record_id,payload)
  SELECT p_marketer_id,'manual_bv',m.id::text,to_jsonb(m)
    FROM admin_manual_bv_sales m WHERE m.marketer_id=p_marketer_id
  ON CONFLICT(marketer_id,record_type,record_id) DO UPDATE
    SET payload=EXCLUDED.payload,archived_at=now(),restored_at=NULL;

  GET DIAGNOSTICS v_manual_rows = ROW_COUNT;

  INSERT INTO network_bv_deletion_archive(marketer_id,record_type,record_id,payload)
  SELECT p_marketer_id,'sales_qualification',q.marketer_id,to_jsonb(q)
    FROM network_sales_qualification q WHERE q.marketer_id=p_marketer_id
  ON CONFLICT(marketer_id,record_type,record_id) DO UPDATE
    SET payload=EXCLUDED.payload,archived_at=now(),restored_at=NULL;

  DELETE FROM network_bv_ledger
   WHERE source_member_id=p_marketer_id OR upline_member_id=p_marketer_id;
  DELETE FROM network_bv_balances WHERE member_id=p_marketer_id;
  DELETE FROM admin_manual_bv_sales WHERE marketer_id=p_marketer_id;
  DELETE FROM network_sales_qualification WHERE marketer_id=p_marketer_id;

  FOR a IN SELECT * FROM _network_delete_bv_accounts ORDER BY member_id,account_position LOOP
    PERFORM recalculate_network_bv_account(
      a.member_id,a.account_position,a.initial_carry_right,a.initial_carry_left
    );
    v_accounts := v_accounts+1;
  END LOOP;

  INSERT INTO network_bv_deletion_archive(marketer_id,record_type,record_id,payload)
  VALUES(
    p_marketer_id,'processed',p_marketer_id,
    jsonb_build_object(
      'deleted_at',COALESCE(v_profile.deleted_at,now()),
      'ledger_rows',v_ledger_rows,
      'source_bv',v_source_bv,
      'upline_bv',v_upline_bv,
      'affected_active_upline_accounts',v_accounts,
      'manual_bv_rows',v_manual_rows
    )
  )
  ON CONFLICT(marketer_id,record_type,record_id) DO UPDATE
    SET payload=EXCLUDED.payload,archived_at=now(),restored_at=NULL;

  RETURN jsonb_build_object(
    'ok',true,
    'ledger_rows_archived',v_ledger_rows,
    'source_bv_removed',v_source_bv,
    'deleted_member_upline_bv_removed',v_upline_bv,
    'active_upline_accounts_recalculated',v_accounts,
    'manual_bv_rows_archived',v_manual_rows,
    'wallets_changed',false,
    'wallet_transactions_changed',false,
    'historical_check_amounts_changed',false,
    'placements_preserved_for_active_descendants',true
  );
END;
$$;