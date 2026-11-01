-- Restore a deleted marketer together with every deleted marketer in their
-- placement subtree. BV archives are replayed only after all subtree profiles
-- are active, so archived ledger entries can pass both endpoint checks.
CREATE OR REPLACE FUNCTION admin_restore_marketer_network_tree(p_marketer_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app_a8bd59e089a78f6d
AS $$
DECLARE
  v_root app_profiles%ROWTYPE;
  v_tree_count integer := 0;
  v_profiles_restored integer := 0;
  v_bv_ledger integer := 0;
  v_bv_balances integer := 0;
  v_manual integer := 0;
  v_qualification integer := 0;
  v_member text;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_root
    FROM app_profiles
   WHERE id=p_marketer_id AND role='marketer'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'error','marketer_not_found');
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS _network_restore_tree_ids(
    member_id text PRIMARY KEY
  ) ON COMMIT DROP;
  TRUNCATE _network_restore_tree_ids;

  INSERT INTO _network_restore_tree_ids(member_id)
  WITH RECURSIVE tree(member_id) AS (
    SELECT p_marketer_id
    UNION
    SELECT p.member_id
      FROM network_placements p
      JOIN tree t ON p.owner_marketer_id=t.member_id
  )
  SELECT DISTINCT member_id FROM tree;

  SELECT count(*)::int INTO v_tree_count FROM _network_restore_tree_ids;

  -- Restore only profiles connected below this root through saved placement
  -- edges. No account outside this subtree is touched.
  UPDATE app_profiles a
     SET deleted_at=NULL,status='active'
    FROM _network_restore_tree_ids t
   WHERE a.id=t.member_id
     AND a.role='marketer'
     AND a.deleted_at IS NOT NULL;
  GET DIAGNOSTICS v_profiles_restored=ROW_COUNT;

  -- Earlier restore attempts could mark the processed marker complete while
  -- some ledger rows remained blocked by deleted source/upline profiles.
  -- Re-open only those archive batches that still contain pending records.
  UPDATE network_bv_deletion_archive x
     SET restored_at=NULL
   WHERE x.record_type='processed'
     AND x.marketer_id IN (SELECT member_id FROM _network_restore_tree_ids)
     AND x.restored_at IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM network_bv_deletion_archive pending
        WHERE pending.marketer_id=x.marketer_id
          AND pending.record_type<>'processed'
          AND pending.restored_at IS NULL
     );

  -- Replay each member's own balance/manual/qualification archive. The
  -- underlying restore routine is idempotent and checks conflicting ledger IDs.
  FOR v_member IN
    SELECT t.member_id
      FROM _network_restore_tree_ids t
      JOIN app_profiles a ON a.id=t.member_id AND a.role='marketer'
     WHERE EXISTS (
       SELECT 1 FROM network_bv_deletion_archive x
        WHERE x.marketer_id=t.member_id
          AND x.record_type='processed'
          AND x.restored_at IS NULL
     )
     ORDER BY t.member_id
  LOOP
    SELECT admin_restore_marketer_network_bv(v_member) INTO v_result;
    v_results := v_results || jsonb_build_array(
      jsonb_build_object('member_id',v_member,'result',COALESCE(v_result,'{}'::jsonb))
    );
    IF COALESCE((v_result->>'ok')::boolean,false)=false THEN
      RAISE EXCEPTION 'Network subtree BV restore failed for member %: %',
        v_member,COALESCE(v_result->>'error','unknown_error');
    END IF;
    v_bv_ledger := v_bv_ledger + COALESCE((v_result->>'ledger_rows_restored')::integer,0);
    v_bv_balances := v_bv_balances + COALESCE((v_result->>'balance_rows_restored')::integer,0);
    v_manual := v_manual + COALESCE((v_result->>'manual_bv_rows_restored')::integer,0);
    v_qualification := v_qualification + COALESCE((v_result->>'sales_qualification_rows_restored')::integer,0);
  END LOOP;

  -- Any pending ledger row whose two endpoints are now active must have been
  -- replayed; fail atomically rather than report a partial network restoration.
  IF EXISTS (
    SELECT 1
      FROM network_bv_deletion_archive x
      JOIN app_profiles src ON src.id=x.payload->>'source_member_id' AND src.deleted_at IS NULL
      JOIN app_profiles up ON up.id=x.payload->>'upline_member_id' AND up.deleted_at IS NULL
     WHERE x.record_type='ledger'
       AND x.restored_at IS NULL
       AND x.marketer_id IN (SELECT member_id FROM _network_restore_tree_ids)
  ) THEN
    RAISE EXCEPTION 'Pending BV ledger rows remain inside the restored network subtree';
  END IF;

  RETURN jsonb_build_object(
    'ok',true,
    'root_marketer_id',p_marketer_id,
    'network_members_total',v_tree_count,
    'deleted_profiles_restored',v_profiles_restored,
    'bv_ledger_rows_restored',v_bv_ledger,
    'bv_balance_rows_restored',v_bv_balances,
    'manual_bv_rows_restored',v_manual,
    'sales_qualification_rows_restored',v_qualification,
    'member_restore_results',v_results,
    'wallets_and_wallet_transactions_changed',false,
    'commissions_and_cheque_amounts_changed',false,
    'placements_changed',false
  );
END;
$$;