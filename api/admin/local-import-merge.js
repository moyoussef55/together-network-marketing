import { db } from "hatchable";

import { requireAdminSession } from "../../lib/admin-auth.js";
export const access = "public";
export const methods = ["POST"];

const bodyOf = req => typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
const mapCTE = `WITH src AS (
  SELECT source_id,payload,lower(trim(COALESCE(payload->>'email',''))) src_email
  FROM legacy_import_source_records
  WHERE collection_name='agents' AND lower(COALESCE(payload->>'role',''))<>'admin'
), mapped AS (
  SELECT s.source_id,s.payload,COALESCE(p.id,s.source_id) target_id
  FROM src s
  LEFT JOIN app_profiles p ON s.src_email<>'' AND lower(COALESCE(p.email,''))=s.src_email
)`;

export default async function(req,res) { if(!(await requireAdminSession(req,res)))return;
  try {
    const b = bodyOf(req);
    if (b.action === "status") {
      const r = await db.query("SELECT collection_name,count(*)::int records FROM legacy_import_source_records GROUP BY collection_name ORDER BY collection_name");
      const p = await db.query("SELECT count(*)::int total, count(*) FILTER (WHERE legacy_member_code IS NOT NULL)::int legacy_codes FROM app_profiles WHERE role='marketer'");
      const n = await db.query("SELECT count(*)::int placements FROM network_placements");
      const w = await db.query("SELECT count(*)::int wallets FROM wallets");
      const bv = await db.query("SELECT count(*)::int rows FROM network_bv_balances");
      const bh = await db.query("SELECT count(*)::int rows FROM wallet_transactions WHERE reference LIKE 'legacy-balance:%'");
      const tr = await db.query("SELECT count(*)::int rows FROM wallet_transactions WHERE reference LIKE 'legacy-transfer:%'");
      const wd = await db.query("SELECT count(*)::int rows FROM withdrawal_requests WHERE note='Imported from legacy withdrawal record'");
      return res.json({ok:true,source:r.rows,profiles:p.rows[0],placements:n.rows[0].placements,wallets:w.rows[0].wallets,bv_balances:bv.rows[0].rows,balance_history:bh.rows[0].rows,transfer_entries:tr.rows[0].rows,withdrawals:wd.rows[0].rows});
    }
    if (b.action !== "merge") return res.status(400).json({error:"invalid_action"});

    const results = {};
    const walletSql = `${mapCTE}
      INSERT INTO wallets(user_id,balance,updated_at)
      SELECT target_id,COALESCE(NULLIF(payload->>'balance','')::numeric,0),
             COALESCE(NULLIF(payload->'updatedAt'->>'$date','')::timestamptz,now())
      FROM mapped
      ON CONFLICT(user_id) DO NOTHING`;
    results.wallets = (await db.query(walletSql)).rowCount;

    const placementSql = `${mapCTE}, slots AS (
      SELECT m.source_id parent_source,m.target_id parent_target,
             v.child_source,v.position_no,v.side
      FROM mapped m
      CROSS JOIN LATERAL (VALUES
        (m.payload->'leftChild0'->>'$oid',2,'left'),
        (m.payload->'rightChild0'->>'$oid',2,'right'),
        (m.payload->'leftChild1'->>'$oid',3,'left'),
        (m.payload->'rightChild1'->>'$oid',3,'right')
      ) v(child_source,position_no,side)
      WHERE NULLIF(v.child_source,'') IS NOT NULL
        AND v.child_source<>'000000000000000000000000'
    ), resolved AS (
      SELECT s.parent_target,s.position_no,s.side,c.target_id child_target
      FROM slots s JOIN mapped c ON c.source_id=s.child_source
    ), chosen AS (
      SELECT DISTINCT ON (r.child_target) r.parent_target,r.position_no,r.side,r.child_target
      FROM resolved r
      WHERE NOT EXISTS (SELECT 1 FROM network_placements n WHERE n.member_id=r.child_target)
      ORDER BY r.child_target,r.position_no,r.parent_target
    )
    INSERT INTO network_placements(owner_marketer_id,account_position,side,member_id,parent_member_id)
    SELECT r.parent_target,r.position_no,r.side,r.child_target,r.parent_target
    FROM chosen r`;
    results.placements = (await db.query(placementSql)).rowCount;

    const bvSql = `${mapCTE}, vals AS (
      SELECT target_id,1 position_no,
        COALESCE(NULLIF(payload->>'rightPv','')::bigint,0) tr,
        COALESCE(NULLIF(payload->>'leftPv','')::bigint,0) tl,
        COALESCE(NULLIF(payload->>'carryRight','')::bigint,0) cr,
        COALESCE(NULLIF(payload->>'carryLeft','')::bigint,0) cl FROM mapped
      UNION ALL
      SELECT target_id,2,
        COALESCE(NULLIF(payload->>'rightPv2','')::bigint,0),
        COALESCE(NULLIF(payload->>'leftPv2','')::bigint,0),
        COALESCE(NULLIF(payload->>'carryRight2','')::bigint,0),
        COALESCE(NULLIF(payload->>'carryLeft2','')::bigint,0) FROM mapped
      UNION ALL
      SELECT target_id,3,
        COALESCE(NULLIF(payload->>'rightPv3','')::bigint,0),
        COALESCE(NULLIF(payload->>'leftPv3','')::bigint,0),
        COALESCE(NULLIF(payload->>'carryRight3','')::bigint,0),
        COALESCE(NULLIF(payload->>'carryLeft3','')::bigint,0) FROM mapped
    )
    INSERT INTO network_bv_balances(member_id,account_position,total_right,total_left,carry_right,carry_left,updated_at)
    SELECT v.target_id,v.position_no,v.tr,v.tl,v.cr,v.cl,now() FROM vals v
    WHERE NOT EXISTS (
      SELECT 1 FROM network_bv_balances n
      WHERE n.member_id=v.target_id AND n.account_position=v.position_no
    )`;
    results.bv_balances = (await db.query(bvSql)).rowCount;

    const balanceHistorySql = `${mapCTE}, h AS (
      SELECT s.source_id,s.payload,
        COALESCE(m.target_id, s.payload->'agentId'->>'$oid') target_id
      FROM legacy_import_source_records s
      LEFT JOIN mapped m ON m.source_id=s.payload->'agentId'->>'$oid'
      WHERE s.collection_name='balancehistories'
    )
    INSERT INTO wallet_transactions(user_id,type,amount,reference,created_at)
    SELECT h.target_id,COALESCE(NULLIF(h.payload->>'status',''),'legacy_balance'),
      COALESCE(NULLIF(h.payload->>'value','')::numeric,0),
      'legacy-balance:'||h.source_id,
      COALESCE(NULLIF(h.payload->'createdAt'->>'$date','')::timestamptz,now())
    FROM h
    WHERE EXISTS (SELECT 1 FROM app_profiles p WHERE p.id=h.target_id AND p.role='marketer')
      AND NOT EXISTS (SELECT 1 FROM wallet_transactions w WHERE w.user_id=h.target_id AND w.reference='legacy-balance:'||h.source_id)`;
    results.balance_history = (await db.query(balanceHistorySql)).rowCount;

    const transferSql = `${mapCTE}, h AS (
      SELECT s.source_id,s.payload,
        f.target_id from_id,t.target_id to_id
      FROM legacy_import_source_records s
      LEFT JOIN mapped f ON f.source_id=s.payload->'from'->>'$oid'
      LEFT JOIN mapped t ON t.source_id=s.payload->'to'->>'$oid'
      WHERE s.collection_name='transferhistories'
    ), entries AS (
      SELECT source_id,from_id user_id,'transfer_sent'::text type,
        -ABS(COALESCE(NULLIF(payload->>'request','')::numeric,0)) amount,
        'legacy-transfer:'||source_id||':out' reference,
        COALESCE(NULLIF(payload->'createdAt'->>'$date','')::timestamptz,now()) created_at
      FROM h WHERE from_id IS NOT NULL
      UNION ALL
      SELECT source_id,to_id,'transfer_received',
        ABS(COALESCE(NULLIF(payload->>'request','')::numeric,0)),
        'legacy-transfer:'||source_id||':in',
        COALESCE(NULLIF(payload->'createdAt'->>'$date','')::timestamptz,now())
      FROM h WHERE to_id IS NOT NULL
    )
    INSERT INTO wallet_transactions(user_id,type,amount,reference,created_at)
    SELECT e.user_id,e.type,e.amount,e.reference,e.created_at FROM entries e
    WHERE EXISTS (SELECT 1 FROM app_profiles p WHERE p.id=e.user_id AND p.role='marketer')
      AND NOT EXISTS (SELECT 1 FROM wallet_transactions w WHERE w.user_id=e.user_id AND w.reference=e.reference)`;
    results.transfers = (await db.query(transferSql)).rowCount;

    const withdrawalsSql = `${mapCTE}, h AS (
      SELECT s.source_id,s.payload,m.target_id
      FROM legacy_import_source_records s
      JOIN mapped m ON m.source_id=s.payload->'agentId'->>'$oid'
      WHERE s.collection_name='withdraws'
    )
    INSERT INTO withdrawal_requests(id,user_id,amount,status,note,created_at,full_name,transfer_phone)
    SELECT (substr(md5(source_id),1,8)||'-'||substr(md5(source_id),9,4)||'-'||substr(md5(source_id),13,4)||'-'||substr(md5(source_id),17,4)||'-'||substr(md5(source_id),21,12))::uuid,
      target_id,COALESCE(NULLIF(payload->>'request','')::numeric,0),
      CASE lower(COALESCE(payload->>'status','pending'))
        WHEN 'paid' THEN 'completed' WHEN 'approved' THEN 'completed' WHEN 'done' THEN 'completed'
        WHEN 'completed' THEN 'completed' WHEN 'rejected' THEN 'rejected' WHEN 'cancelled' THEN 'cancelled'
        ELSE 'pending' END,
      'Imported from legacy withdrawal record',
      COALESCE(NULLIF(payload->'createdAt'->>'$date','')::timestamptz,now()),
      (SELECT display_name FROM app_profiles p WHERE p.id=target_id),
      (SELECT phone FROM app_profiles p WHERE p.id=target_id)
    FROM h
    WHERE NOT EXISTS (
      SELECT 1 FROM withdrawal_requests w
      WHERE w.id=(substr(md5(h.source_id),1,8)||'-'||substr(md5(h.source_id),9,4)||'-'||substr(md5(h.source_id),13,4)||'-'||substr(md5(h.source_id),17,4)||'-'||substr(md5(h.source_id),21,12))::uuid
    )`;
    results.withdrawals = (await db.query(withdrawalsSql)).rowCount;

    await db.query("UPDATE local_migration_uploads SET status='processed' WHERE id='c4170d59-f027-4d56-968b-d091606a1001'::uuid AND status='staged'");
    return res.json({ok:true,results,archive_note:"All six source collections remain preserved in legacy_import_source_records. Agent history and commission configuration are retained verbatim there; only unambiguous current-state and transaction records were mapped into live tables."});
  } catch (e) {
    return res.status(500).json({error:"legacy_merge_failed",message:String(e?.message||e).slice(0,300)});
  }
}