-- Reversible marketer deletion restore + admin-controlled visibility in the network.
ALTER TABLE app_profiles
  ADD COLUMN IF NOT EXISTS network_hidden boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS app_profiles_network_visible_idx
  ON app_profiles(id)
  WHERE role='marketer' AND deleted_at IS NULL AND network_hidden=false;

CREATE OR REPLACE FUNCTION admin_restore_marketer_network_bv(p_marketer_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app_a8bd59e089a78f6d
AS $$
DECLARE
  v_profile app_profiles%ROWTYPE;
  v_has_archive boolean := false;
  v_ledger_rows integer := 0;
  v_balance_rows integer := 0;
  v_manual_rows integer := 0;
  v_qualification_rows integer := 0;
  v_accounts integer := 0;
  v_reports integer := 0;
  a record;
BEGIN
  SELECT * INTO v_profile
    FROM app_profiles
   WHERE id=p_marketer_id AND role='marketer'
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'error','marketer_not_found');
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM network_bv_deletion_archive
     WHERE marketer_id=p_marketer_id
       AND record_type='processed'
       AND restored_at IS NULL
  ) INTO v_has_archive;

  IF NOT v_has_archive THEN
    IF v_profile.deleted_at IS NULL THEN
      RETURN jsonb_build_object('ok',true,'already_restored',true);
    END IF;
    UPDATE app_profiles
       SET deleted_at=NULL,status='active'
     WHERE id=p_marketer_id;
    RETURN jsonb_build_object(
      'ok',true,'restored_without_bv_archive',true,
      'warning','No pending BV deletion archive existed for this marketer.'
    );
  END IF;

  -- Capture each active upline's opening carry BEFORE restoring the deleted
  -- ledger entries. This reverses the exact baseline used by deletion recalculation.
  CREATE TEMP TABLE IF NOT EXISTS _network_restore_bv_accounts (
    member_id text NOT NULL,
    account_position integer NOT NULL,
    initial_carry_right bigint NOT NULL,
    initial_carry_left bigint NOT NULL,
    PRIMARY KEY(member_id,account_position)
  ) ON COMMIT DROP;
  TRUNCATE _network_restore_bv_accounts;

  INSERT INTO _network_restore_bv_accounts(
    member_id,account_position,initial_carry_right,initial_carry_left
  )
  WITH impacted AS (
    SELECT DISTINCT
           x.payload->>'upline_member_id' AS member_id,
           (x.payload->>'account_position')::integer AS account_position
      FROM network_bv_deletion_archive x
      JOIN app_profiles s ON s.id=x.payload->>'source_member_id'
                         AND (s.deleted_at IS NULL OR s.id=p_marketer_id)
      JOIN app_profiles u ON u.id=x.payload->>'upline_member_id'
                         AND (u.deleted_at IS NULL OR u.id=p_marketer_id)
     WHERE x.record_type='ledger'
       AND x.restored_at IS NULL
       AND x.marketer_id=x.payload->>'source_member_id'
       AND x.payload->>'upline_member_id'<>x.payload->>'source_member_id'
  )
  SELECT i.member_id,i.account_position,
         CASE WHEN first_s.id IS NULL THEN COALESCE(b.carry_right,archived_balance.carry_right,0)
              ELSE first_s.right_bv-COALESCE(periods.period_right,0) END,
         CASE WHEN first_s.id IS NULL THEN COALESCE(b.carry_left,archived_balance.carry_left,0)
              ELSE first_s.left_bv-COALESCE(periods.period_left,0) END
    FROM impacted i
    LEFT JOIN network_bv_balances b
      ON b.member_id=i.member_id AND b.account_position=i.account_position
    LEFT JOIN LATERAL (
      SELECT (x.payload->>'carry_right')::bigint AS carry_right,
             (x.payload->>'carry_left')::bigint AS carry_left
        FROM network_bv_deletion_archive x
       WHERE x.record_type='balance'
         AND x.marketer_id=i.member_id
         AND x.record_id=i.member_id||':'||i.account_position::text
       ORDER BY x.archived_at DESC LIMIT 1
    ) archived_balance ON true
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
    SELECT 1 FROM _network_restore_bv_accounts
     WHERE initial_carry_right<0 OR initial_carry_left<0
  ) THEN
    RETURN jsonb_build_object(
      'ok',false,'error','network_bv_baseline_inconsistent',
      'message','The upline BV opening carry is inconsistent; no restore was applied.'
    );
  END IF;

  -- Refuse conflicting ledger identities instead of silently omitting BV.
  IF EXISTS (
    SELECT 1
      FROM network_bv_deletion_archive x
      CROSS JOIN LATERAL jsonb_to_record(x.payload) AS l(
        id bigint,order_id text,source_member_id text,upline_member_id text,
        account_position integer,side text,bv integer,sale_at timestamptz,created_at timestamptz
      )
      JOIN app_profiles src ON src.id=l.source_member_id
                           AND (src.deleted_at IS NULL OR src.id=p_marketer_id)
      JOIN app_profiles up ON up.id=l.upline_member_id
                          AND (up.deleted_at IS NULL OR up.id=p_marketer_id)
      JOIN network_bv_ledger live
        ON live.order_id=l.order_id
       AND live.upline_member_id=l.upline_member_id
       AND live.account_position=l.account_position
       AND live.side=l.side
     WHERE x.record_type='ledger'
       AND x.restored_at IS NULL
       AND (live.source_member_id<>l.source_member_id OR live.bv<>l.bv)
  ) OR EXISTS (
    SELECT 1
      FROM network_bv_deletion_archive x
      CROSS JOIN LATERAL jsonb_to_record(x.payload) AS l(
        id bigint,order_id text,source_member_id text,upline_member_id text,
        account_position integer,side text,bv integer,sale_at timestamptz,created_at timestamptz
      )
      JOIN app_profiles src ON src.id=l.source_member_id
                           AND (src.deleted_at IS NULL OR src.id=p_marketer_id)
      JOIN app_profiles up ON up.id=l.upline_member_id
                          AND (up.deleted_at IS NULL OR up.id=p_marketer_id)
      JOIN network_bv_ledger live ON live.id=l.id
     WHERE x.record_type='ledger'
       AND x.restored_at IS NULL
       AND (live.order_id<>l.order_id
         OR live.source_member_id<>l.source_member_id
         OR live.upline_member_id<>l.upline_member_id
         OR live.account_position<>l.account_position
         OR live.side<>l.side
         OR live.bv<>l.bv)
  ) THEN
    RETURN jsonb_build_object('ok',false,'error','network_bv_restore_conflict');
  END IF;

  -- The profile was a soft-delete only; restore it without touching orders,
  -- commissions, withdrawals, wallet history, or cheque amounts.
  UPDATE app_profiles
     SET deleted_at=NULL,status='active'
   WHERE id=p_marketer_id AND role='marketer';

  INSERT INTO network_bv_ledger(
    id,order_id,source_member_id,upline_member_id,account_position,side,bv,sale_at,created_at
  )
  SELECT (x.payload->>'id')::bigint,
         x.payload->>'order_id',
         x.payload->>'source_member_id',
         x.payload->>'upline_member_id',
         (x.payload->>'account_position')::integer,
         x.payload->>'side',
         (x.payload->>'bv')::integer,
         (x.payload->>'sale_at')::timestamptz,
         COALESCE((x.payload->>'created_at')::timestamptz,now())
    FROM network_bv_deletion_archive x
    JOIN app_profiles src ON src.id=x.payload->>'source_member_id' AND src.deleted_at IS NULL
    JOIN app_profiles up ON up.id=x.payload->>'upline_member_id' AND up.deleted_at IS NULL
   WHERE x.record_type='ledger'
     AND x.restored_at IS NULL
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_ledger_rows=ROW_COUNT;

  INSERT INTO network_bv_balances(
    member_id,account_position,total_right,total_left,carry_right,carry_left,updated_at
  )
  SELECT x.payload->>'member_id',
         (x.payload->>'account_position')::integer,
         COALESCE((x.payload->>'total_right')::bigint,0),
         COALESCE((x.payload->>'total_left')::bigint,0),
         COALESCE((x.payload->>'carry_right')::bigint,0),
         COALESCE((x.payload->>'carry_left')::bigint,0),
         COALESCE((x.payload->>'updated_at')::timestamptz,now())
    FROM network_bv_deletion_archive x
   WHERE x.marketer_id=p_marketer_id
     AND x.record_type='balance'
     AND x.restored_at IS NULL
  ON CONFLICT(member_id,account_position) DO UPDATE SET
    total_right=EXCLUDED.total_right,
    total_left=EXCLUDED.total_left,
    carry_right=EXCLUDED.carry_right,
    carry_left=EXCLUDED.carry_left,
    updated_at=now();
  GET DIAGNOSTICS v_balance_rows=ROW_COUNT;

  INSERT INTO admin_manual_bv_sales(id,marketer_id,account_position,side,bv,mode,created_by,created_at)
  SELECT (x.payload->>'id')::uuid,
         x.payload->>'marketer_id',
         (x.payload->>'account_position')::integer,
         x.payload->>'side',
         COALESCE((x.payload->>'bv')::integer,1000),
         COALESCE(x.payload->>'mode','real'),
         x.payload->>'created_by',
         COALESCE((x.payload->>'created_at')::timestamptz,now())
    FROM network_bv_deletion_archive x
   WHERE x.marketer_id=p_marketer_id
     AND x.record_type='manual_bv'
     AND x.restored_at IS NULL
  ON CONFLICT(id) DO NOTHING;
  GET DIAGNOSTICS v_manual_rows=ROW_COUNT;

  INSERT INTO network_sales_qualification(marketer_id,qualified_sales,updated_at)
  SELECT x.payload->>'marketer_id',
         COALESCE((x.payload->>'qualified_sales')::integer,0),
         COALESCE((x.payload->>'updated_at')::timestamptz,now())
    FROM network_bv_deletion_archive x
   WHERE x.marketer_id=p_marketer_id
     AND x.record_type='sales_qualification'
     AND x.restored_at IS NULL
  ON CONFLICT(marketer_id) DO UPDATE SET
    qualified_sales=EXCLUDED.qualified_sales,
    updated_at=EXCLUDED.updated_at;
  GET DIAGNOSTICS v_qualification_rows=ROW_COUNT;

  -- Mark every now-live archived ledger item as restored (rows can be archived
  -- under either the source or the upline if more than one person was deleted).
  UPDATE network_bv_deletion_archive x
     SET restored_at=now()
    FROM network_bv_ledger l
    JOIN app_profiles src ON src.id=l.source_member_id AND src.deleted_at IS NULL
    JOIN app_profiles up ON up.id=l.upline_member_id AND up.deleted_at IS NULL
   WHERE x.record_type='ledger'
     AND x.restored_at IS NULL
     AND (x.payload->>'order_id')=l.order_id
     AND (x.payload->>'source_member_id')=l.source_member_id
     AND (x.payload->>'upline_member_id')=l.upline_member_id
     AND (x.payload->>'account_position')::integer=l.account_position
     AND (x.payload->>'side')=l.side
     AND (x.payload->>'bv')::integer=l.bv;

  -- Recompute each affected active upline from the restored source ledger.
  -- recalculate_network_bv_account leaves check_amount and settled_at untouched.
  FOR a IN
    SELECT * FROM _network_restore_bv_accounts
     ORDER BY member_id,account_position
  LOOP
    PERFORM recalculate_network_bv_account(
      a.member_id,a.account_position,a.initial_carry_right,a.initial_carry_left
    );
    v_accounts:=v_accounts+1;
  END LOOP;

  -- Refresh BV columns in saved weekly reports for the restored marketer and uplines.
  SELECT admin_refresh_network_bv_update_reports(NULL)
    INTO v_reports;

  -- Mark this marketer's own profile/BV metadata archive as restored. Any ledger
  -- records still referencing another deleted profile remain pending until both
  -- endpoints are active, and will be picked up by that person's restore.
  UPDATE network_bv_deletion_archive
     SET restored_at=now()
   WHERE marketer_id=p_marketer_id
     AND record_type<>'ledger'
     AND restored_at IS NULL;

  RETURN jsonb_build_object(
    'ok',true,
    'ledger_rows_restored',v_ledger_rows,
    'balance_rows_restored',v_balance_rows,
    'manual_bv_rows_restored',v_manual_rows,
    'sales_qualification_rows_restored',v_qualification_rows,
    'active_upline_accounts_recalculated',v_accounts,
    'report_rows_refreshed',COALESCE(v_reports,0),
    'commissions_and_cheque_amounts_changed',false,
    'wallets_and_wallet_transactions_changed',false,
    'placement_links_preserved',true
  );
END;
$$;