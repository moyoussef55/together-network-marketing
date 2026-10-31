import { db } from "hatchable";
import crypto from "node:crypto";
import { requireAdminSession } from "../../lib/admin-auth.js";

export const access = "public";
export const methods = ["POST"];

const UPLOAD_ID = "773fcb03-0b45-403d-b060-1d040175b4cc";
const idOf = v => v && typeof v === "object" ? String(v.$oid || v._id || "") : String(v || "");
const num = v => {
  if (v == null || v === "") return 0;
  if (typeof v === "object") return Number(v.$numberLong ?? v.$numberInt ?? v.$numberDouble ?? v.$numberDecimal ?? 0) || 0;
  return Number(v) || 0;
};
const dateOf = v => {
  const x = v && typeof v === "object" && v.$date ? v.$date : v;
  if (!x) return null;
  const d = new Date(x);
  return Number.isNaN(d.valueOf()) ? null : d.toISOString();
};
const phoneOf = v => {
  const s = String(v ?? "").trim().replace(/[^0-9+]/g, "");
  return s || null;
};
const fullNameOf = a => [a?.firstName,a?.secondName,a?.thirdName,a?.lastName].map(x=>String(x||"").trim()).filter(Boolean).join(" ");
const safePayload = value => {
  const out = {...value};
  for (const k of ["password","passwordHash","password_hash","login_password_hash","wallet_password_hash","walletPassword","walletPasswordHash","secret","accessToken","refreshToken"]) delete out[k];
  return out;
};
const sourceIdOf = v => idOf(v?._id) || String(v?._id || "") || crypto.createHash("sha256").update(JSON.stringify(v||{})).digest("hex").slice(0,24);
const stableSha256 = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const deterministicUuid = value => {
  const h = stableSha256(value);
  return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20,32);
};
const sourceFields = [
  ["rightPv","leftPv","carryRight","carryLeft"],
  ["rightPv2","leftPv2","carryRight2","carryLeft2"],
  ["rightPv3","leftPv3","carryRight3","carryLeft3"]
];

export default async function handler(req,res) {
  if (!(await requireAdminSession(req,res))) return;
  let stage = "validate_request";
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    if (body.confirm !== "APPLY-LEGACY-20261031") {
      return res.status(400).json({ok:false,error:"explicit_apply_phrase_required"});
    }

    stage = "read_staged_source";
    const u = await db.query(
      "SELECT id,expected_bytes,expected_chunks,status FROM local_migration_uploads WHERE id=$1 LIMIT 1",
      [UPLOAD_ID]
    );
    if (!u.rows.length || u.rows[0].status !== "staged") {
      return res.status(404).json({ok:false,error:"staged_source_unavailable"});
    }
    const chunks = await db.query(
      "SELECT chunk_index,content FROM local_migration_upload_chunks WHERE upload_id=$1 ORDER BY chunk_index",
      [UPLOAD_ID]
    );
    const raw = chunks.rows.map(x=>x.content).join("");
    if (chunks.rows.length !== Number(u.rows[0].expected_chunks) || raw.length !== Number(u.rows[0].expected_bytes)) {
      return res.status(409).json({ok:false,error:"staged_source_integrity_error"});
    }
    const source = JSON.parse(raw);
    if (source.exportFormat !== "together-network-migration-v1") {
      return res.status(400).json({ok:false,error:"unexpected_export_format"});
    }

    const col = source.collections || {};
    const allAgents = Array.isArray(col.agents) ? col.agents : [];
    const agents = allAgents.filter(a=>String(a?.role||"").toLowerCase()==="agent");
    const adminRows = allAgents.filter(a=>String(a?.role||"").toLowerCase()==="admin");
    const agentHistories = Array.isArray(col.agenthistories) ? col.agenthistories : [];
    const balanceHistories = Array.isArray(col.balancehistories) ? col.balancehistories : [];
    const transfers = Array.isArray(col.transferhistories) ? col.transferhistories : [];
    const withdrawals = Array.isArray(col.withdraws) ? col.withdraws : [];

    if (agents.length !== 192 || adminRows.length !== 1) {
      return res.status(409).json({ok:false,error:"source_agent_role_counts_changed",agents:agents.length,admin:adminRows.length});
    }
    const sourceIds = agents.map(a=>idOf(a._id));
    const idSet = new Set(sourceIds);
    if (sourceIds.some(x=>!x) || idSet.size !== 192) {
      return res.status(409).json({ok:false,error:"source_agent_ids_invalid"});
    }

    stage = "preflight_identity_and_slots";
    const exact = await db.query(
      "SELECT count(*)::int n FROM app_profiles WHERE role='marketer' AND id=ANY($1::text[])",
      [sourceIds]
    );
    if (![180,192].includes(Number(exact.rows[0]?.n||0))) {
      return res.status(409).json({ok:false,error:"unexpected_existing_source_id_matches",matched:Number(exact.rows[0]?.n||0)});
    }
    const emailList = agents.map(a=>String(a.email||"").trim().toLowerCase()).filter(Boolean);
    const emailConflict = await db.query(
      "SELECT count(*)::int n FROM app_profiles WHERE lower(email)=ANY($1::text[]) AND NOT(id=ANY($2::text[]))",
      [emailList,sourceIds]
    );
    if (Number(emailConflict.rows[0]?.n||0) > 0) {
      return res.status(409).json({ok:false,error:"source_email_conflict",count:Number(emailConflict.rows[0].n)});
    }

    const profileRows = [];
    const newProfiles = [];
    const sourceParentRows = [];
    const placementRows = [];

    const historiesByAgent = new Map();
    for (const h of balanceHistories) {
      const uid=idOf(h.agentId);
      if (!uid) continue;
      if (!historiesByAgent.has(uid)) historiesByAgent.set(uid,[]);
      historiesByAgent.get(uid).push(h);
    }

    for (const a of agents) {
      const id=idOf(a._id);
      const createdAt=dateOf(a.createdAt) || new Date().toISOString();
      const activated=String(a.packageActivate).toLowerCase()==="true";
      const productDates=(historiesByAgent.get(id)||[])
        .filter(h=>String(h.status||"").toLowerCase()==="product")
        .map(h=>dateOf(h.createdAt)||dateOf(h.updatedAt))
        .filter(Boolean)
        .sort();
      const activationAt=activated ? (productDates[0] || createdAt) : null;
      const fullName=fullNameOf(a);
      const row={
        id,first_name:String(a.firstName||"").trim()||null,
        second_name:String(a.secondName||"").trim()||null,
        third_name:String(a.thirdName||"").trim()||null,
        fourth_name:String(a.lastName||"").trim()||null,
        display_name:fullName||null,phone:phoneOf(a.phone),
        email:String(a.email||"").trim().toLowerCase()||null,
        national_id:String(a.nationalId||"").trim()||null,
        country:String(a.country||"").trim()||null,
        state:String(a.governorate||"").trim()||null,
        city:String(a.city||"").trim()||null,
        address:String(a.address||"").trim()||null,
        heir_name:String(a.inheritorName||"").trim()||null,
        heir_mother_name:String(a.grandfatherInheritorName||"").trim()||null,
        legacy_member_code:String(a.id||"").trim()||null,
        parent_id:idOf(a.parent)||null
      };
      profileRows.push(row);
      sourceParentRows.push({id,parent_id:row.parent_id});
    }

    const targetExisting = await db.query(
      "SELECT id FROM app_profiles WHERE id=ANY($1::text[]) AND role='marketer'",
      [sourceIds]
    );
    const existingSet = new Set(targetExisting.rows.map(x=>String(x.id)));
    for (const a of agents) {
      const id=idOf(a._id);
      if (existingSet.has(id)) continue;
      const createdAt=dateOf(a.createdAt)||new Date().toISOString();
      const activated=String(a.packageActivate).toLowerCase()==="true";
      const productDates=(historiesByAgent.get(id)||[])
        .filter(h=>String(h.status||"").toLowerCase()==="product")
        .map(h=>dateOf(h.createdAt)||dateOf(h.updatedAt))
        .filter(Boolean).sort();
      const activationAt=activated?(productDates[0]||createdAt):null;
      const base="TO"+stableSha256(id).slice(0,5);
      let referral=base;
      let attempt=0;
      while (true) {
        const collision=await db.query("SELECT 1 FROM app_profiles WHERE referral_code=$1 LIMIT 1",[referral]);
        if (!collision.rows.length) break;
        attempt++;
        referral="TO"+stableSha256(id+":"+attempt).slice(0,8);
        if (attempt>100) throw new Error("referral_code_generation_failed");
      }
      const level=String(a.level||"").toLowerCase();
      const tier=level==="gold"?3:level==="silver"?2:level==="bronze"?1:0;
      await db.query(
        `INSERT INTO app_profiles(
          id,role,referral_code,sponsor_id,display_name,phone,status,
          first_name,second_name,third_name,fourth_name,national_id,email,
          country,state,city,heir_name,heir_mother_name,
          activation_started_at,legacy_member_code,address,
          login_blocked,activation_blocked,admin_tier_override,created_at
        ) VALUES($1,'marketer',$2,NULL,$3,$4,'active',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,false,false,$19,$20)
        ON CONFLICT(id) DO NOTHING`,
        [id,referral,fullNameOf(a)||null,phoneOf(a.phone),a.firstName||null,a.secondName||null,a.thirdName||null,a.lastName||null,a.nationalId||null,
         String(a.email||"").trim().toLowerCase()||null,a.country||null,a.governorate||null,a.city||null,a.inheritorName||null,a.grandfatherInheritorName||null,
         activationAt,String(a.id||"")||null,a.address||null,tier,createdAt]
      );
      newProfiles.push(id);
    }

    stage = "update_existing_profiles";
    await db.query(
      `UPDATE app_profiles p SET
        first_name=COALESCE(NULLIF(s.first_name,''),p.first_name),
        second_name=COALESCE(NULLIF(s.second_name,''),p.second_name),
        third_name=COALESCE(NULLIF(s.third_name,''),p.third_name),
        fourth_name=COALESCE(NULLIF(s.fourth_name,''),p.fourth_name),
        display_name=COALESCE(NULLIF(s.display_name,''),p.display_name),
        phone=COALESCE(NULLIF(s.phone,''),p.phone),
        email=COALESCE(NULLIF(s.email,''),p.email),
        national_id=COALESCE(NULLIF(s.national_id,''),p.national_id),
        country=COALESCE(NULLIF(s.country,''),p.country),
        state=COALESCE(NULLIF(s.state,''),p.state),
        city=COALESCE(NULLIF(s.city,''),p.city),
        address=COALESCE(NULLIF(s.address,''),p.address),
        heir_name=COALESCE(NULLIF(s.heir_name,''),p.heir_name),
        heir_mother_name=COALESCE(NULLIF(s.heir_mother_name,''),p.heir_mother_name),
        legacy_member_code=COALESCE(NULLIF(s.legacy_member_code,''),p.legacy_member_code)
       FROM jsonb_to_recordset($1::jsonb) AS s(
         id text,first_name text,second_name text,third_name text,fourth_name text,display_name text,phone text,email text,
         national_id text,country text,state text,city text,address text,heir_name text,heir_mother_name text,legacy_member_code text
       )
       WHERE p.id=s.id AND p.role='marketer'`,
      [JSON.stringify(profileRows)]
    );

    stage = "link_sponsors_and_placements";
    await db.query(
      `UPDATE app_profiles p SET sponsor_id=s.parent_id
       FROM jsonb_to_recordset($1::jsonb) AS s(id text,parent_id text)
       JOIN app_profiles parent ON parent.id=s.parent_id AND parent.role='marketer'
       WHERE p.id=s.id AND p.role='marketer' AND s.parent_id IS NOT NULL`,
      [JSON.stringify(sourceParentRows)]
    );

    for (const a of agents) {
      const parentId=idOf(a._id);
      for (const [field,pos,side] of [["leftChild0",2,"left"],["rightChild0",2,"right"],["leftChild1",3,"left"],["rightChild1",3,"right"]]) {
        const childId=idOf(a[field]);
        if (!childId || childId==="000000000000000000000000") continue;
        if (!idSet.has(parentId) || !idSet.has(childId)) continue;
        placementRows.push({owner_id:parentId,account_position:pos,side,member_id:childId,parent_member_id:parentId});
      }
    }
    const placementConflicts = await db.query(
      `SELECT count(*)::int n
       FROM jsonb_to_recordset($1::jsonb) AS x(owner_id text,account_position integer,side text,member_id text,parent_member_id text)
       LEFT JOIN network_placements member_row ON member_row.member_id=x.member_id
       LEFT JOIN network_placements slot_row ON slot_row.owner_marketer_id=x.owner_id AND slot_row.account_position=x.account_position AND slot_row.side=x.side
       WHERE (member_row.member_id IS NOT NULL AND (
                member_row.owner_marketer_id<>x.owner_id OR member_row.account_position<>x.account_position OR member_row.side<>x.side
             ))
          OR (slot_row.member_id IS NOT NULL AND slot_row.member_id<>x.member_id)`,
      [JSON.stringify(placementRows)]
    );
    if (Number(placementConflicts.rows[0]?.n||0)>0) {
      return res.status(409).json({ok:false,error:"network_placement_conflict",count:Number(placementConflicts.rows[0].n)});
    }
    const placementInsert = await db.query(
      `INSERT INTO network_placements(owner_marketer_id,account_position,side,member_id,parent_member_id)
       SELECT x.owner_id,x.account_position,x.side,x.member_id,x.parent_member_id
       FROM jsonb_to_recordset($1::jsonb) AS x(owner_id text,account_position integer,side text,member_id text,parent_member_id text)
       ON CONFLICT DO NOTHING`,
      [JSON.stringify(placementRows)]
    );

    stage = "update_wallet_balances";
    const walletRows=agents.map(a=>({user_id:idOf(a._id),balance:num(a.balance)}));
    await db.query(
      `SELECT admin_set_marketer_wallet_balance(x.user_id,x.balance)
       FROM jsonb_to_recordset($1::jsonb) AS x(user_id text,balance numeric)`,
      [JSON.stringify(walletRows)]
    );

    stage = "import_signed_wallet_history";
    const agentMap = new Map(agents.map(a=>[idOf(a._id),a]));
    const txRows=[];
    const balanceLegacyRows=[];
    for (const h of balanceHistories) {
      const uid=idOf(h.agentId);
      const agent=agentMap.get(uid);
      if (!agent) continue;
      const sid=sourceIdOf(h);
      txRows.push({
        user_id:uid,transaction_type:String(h.status||"legacy_history").toLowerCase(),
        amount:num(h.value),reference:"legacy-balance:"+sid,
        created_at:dateOf(h.createdAt)||dateOf(h.updatedAt)||new Date().toISOString()
      });
      balanceLegacyRows.push({source_id:sid,payload:h});
    }
    const transactionInsert=await db.query(
      "SELECT import_legacy_wallet_history($1::jsonb) AS inserted",
      [JSON.stringify(txRows)]
    );

    stage = "import_withdrawal_requests";
    const withdrawalMapRows = [];
    const withdrawalLegacyRows = [];
    const sourceWithdrawalIds=withdrawals.map(sourceIdOf);
    const mappedWithdrawals=sourceWithdrawalIds.length
      ? await db.query("SELECT source_id FROM legacy_import_record_map WHERE collection_name='withdraws' AND source_id=ANY($1::text[])",[sourceWithdrawalIds])
      : {rows:[]};
    const mappedWithdrawalSet=new Set(mappedWithdrawals.rows.map(x=>String(x.source_id)));
    for (const w of withdrawals) {
      const sid=sourceIdOf(w);
      const uid=idOf(w.agentId);
      const agent=agentMap.get(uid);
      if (!agent || mappedWithdrawalSet.has(sid) || num(w.request)<=0) continue;
      const requestId=deterministicUuid("together-withdrawal:"+sid);
      const status=["pending","completed","rejected"].includes(String(w.status||"").toLowerCase())?String(w.status).toLowerCase():"pending";
      withdrawalMapRows.push({
        id:requestId,user_id:uid,amount:num(w.request),status,
        note:"Legacy withdrawal import: "+sid,
        created_at:dateOf(w.createdAt)||dateOf(w.updatedAt)||new Date().toISOString(),
        full_name:fullNameOf(agent)||null,transfer_phone:phoneOf(agent.phone)||null
      });
      withdrawalLegacyRows.push({collection_name:"withdraws",source_id:sid,target_table:"withdrawal_requests",target_id:requestId});
    }
    if (withdrawalMapRows.length) {
      await db.query(
        "SELECT import_legacy_withdrawal_requests($1::jsonb) AS inserted",
        [JSON.stringify(withdrawalMapRows)]
      );
      await db.query(
        `INSERT INTO legacy_import_record_map(collection_name,source_id,target_table,target_id)
         SELECT x.collection_name,x.source_id,x.target_table,x.target_id
         FROM jsonb_to_recordset($1::jsonb) AS x(collection_name text,source_id text,target_table text,target_id text)
         ON CONFLICT(collection_name,source_id) DO NOTHING`,
        [JSON.stringify(withdrawalLegacyRows)]
      );
    }

    stage = "upsert_legacy_source_records";
    const putLegacy = async (collection,rows) => {
      if (!rows.length) return 0;
      const mapped=rows.map(r=>({source_id:sourceIdOf(r),payload:safePayload(r)}));
      const result=await db.query(
        `INSERT INTO legacy_import_source_records(collection_name,source_id,payload,imported_at)
         SELECT $1,x.source_id,x.payload,now()
         FROM jsonb_to_recordset($2::jsonb) AS x(source_id text,payload jsonb)
         ON CONFLICT(collection_name,source_id) DO UPDATE
           SET payload=EXCLUDED.payload,imported_at=now()`,
        [collection,JSON.stringify(mapped)]
      );
      return result.rowCount||0;
    };
    await putLegacy("agents",agents);
    await putLegacy("agenthistories",agentHistories);
    await putLegacy("balancehistories",balanceHistories);
    await putLegacy("transferhistories",transfers);
    await putLegacy("withdraws",withdrawals);

    stage = "import_bv_opening_adjustments";
    const bvRows=[];
    for (const a of agents) {
      const memberId=idOf(a._id);
      for (let i=0;i<3;i++) {
        const f=sourceFields[i];
        bvRows.push({
          member_id:memberId,account_position:i+1,
          source_total_right:num(a[f[0]]),source_total_left:num(a[f[1]]),
          source_carry_right:num(a[f[2]]),source_carry_left:num(a[f[3]]),
          source_updated_at:dateOf(a.updatedAt)
        });
      }
    }
    await db.query(
      `INSERT INTO network_bv_opening_adjustments(
        member_id,account_position,adjustment_right,adjustment_left,
        source_total_right,source_total_left,source_carry_right,source_carry_left,
        source_updated_at,source_upload_id,imported_at,updated_at
      )
      SELECT x.member_id,x.account_position,
        x.source_total_right-COALESCE((
          SELECT SUM(l.bv)::bigint FROM network_bv_ledger l
          WHERE l.upline_member_id=x.member_id AND l.account_position=x.account_position AND l.side='right'
        ),0),
        x.source_total_left-COALESCE((
          SELECT SUM(l.bv)::bigint FROM network_bv_ledger l
          WHERE l.upline_member_id=x.member_id AND l.account_position=x.account_position AND l.side='left'
        ),0),
        x.source_total_right,x.source_total_left,x.source_carry_right,x.source_carry_left,
        x.source_updated_at,$2::uuid,now(),now()
      FROM jsonb_to_recordset($1::jsonb) AS x(
        member_id text,account_position integer,source_total_right bigint,source_total_left bigint,
        source_carry_right bigint,source_carry_left bigint,source_updated_at timestamptz
      )
      ON CONFLICT(member_id,account_position) DO UPDATE SET
        adjustment_right=EXCLUDED.adjustment_right,adjustment_left=EXCLUDED.adjustment_left,
        source_total_right=EXCLUDED.source_total_right,source_total_left=EXCLUDED.source_total_left,
        source_carry_right=EXCLUDED.source_carry_right,source_carry_left=EXCLUDED.source_carry_left,
        source_updated_at=EXCLUDED.source_updated_at,source_upload_id=EXCLUDED.source_upload_id,
        imported_at=now(),updated_at=now()`,
      [JSON.stringify(bvRows),UPLOAD_ID]
    );

    await db.query(
      `INSERT INTO network_bv_balances(member_id,account_position,total_right,total_left,carry_right,carry_left,updated_at)
       SELECT x.member_id,x.account_position,0,0,x.source_carry_right,x.source_carry_left,now()
       FROM jsonb_to_recordset($1::jsonb) AS x(
         member_id text,account_position integer,source_total_right bigint,source_total_left bigint,
         source_carry_right bigint,source_carry_left bigint,source_updated_at timestamptz
       )
       ON CONFLICT(member_id,account_position) DO UPDATE SET
         carry_right=EXCLUDED.carry_right,carry_left=EXCLUDED.carry_left,updated_at=now()`,
      [JSON.stringify(bvRows)]
    );

    await db.query(
      `UPDATE network_bv_balances b SET
        total_right=COALESCE((SELECT SUM(l.bv) FROM network_bv_ledger l WHERE l.upline_member_id=b.member_id AND l.account_position=b.account_position AND l.side='right'),0)
          + COALESCE((SELECT a.adjustment_right FROM network_bv_opening_adjustments a WHERE a.member_id=b.member_id AND a.account_position=b.account_position),0),
        total_left=COALESCE((SELECT SUM(l.bv) FROM network_bv_ledger l WHERE l.upline_member_id=b.member_id AND l.account_position=b.account_position AND l.side='left'),0)
          + COALESCE((SELECT a.adjustment_left FROM network_bv_opening_adjustments a WHERE a.member_id=b.member_id AND a.account_position=b.account_position),0),
        updated_at=now()`
    );

    stage = "finalize_migration_week_boundary";
    const boundaryResult=await db.query(
      "SELECT max(week_end)::text AS week_end FROM network_bv_settlements WHERE member_id=ANY($1::text[]) AND is_finalized=true",
      [sourceIds]
    );
    const weekEnd=String(boundaryResult.rows[0]?.week_end||"");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekEnd)) throw new Error("no_finalized_bv_week_boundary");
    const endDate=new Date(weekEnd+"T00:00:00.000Z");
    endDate.setUTCDate(endDate.getUTCDate()-7);
    const weekStart=endDate.toISOString().slice(0,10);
    const boundaryRows=bvRows.map(x=>({
      member_id:x.member_id,account_position:x.account_position,
      week_start:weekStart,week_end:weekEnd,
      carry_right:x.source_carry_right,carry_left:x.source_carry_left
    }));
    await db.query(
      `INSERT INTO network_bv_settlements(
        member_id,account_position,week_start,week_end,right_bv,left_bv,matched_bv,
        check_amount,carry_right,carry_left,is_finalized,settled_at
      )
      SELECT x.member_id,x.account_position,x.week_start::date,x.week_end::date,0,0,0,0,
             x.carry_right,x.carry_left,true,
             x.week_end::date::timestamp AT TIME ZONE 'Africa/Cairo'
      FROM jsonb_to_recordset($1::jsonb) AS x(
        member_id text,account_position integer,week_start text,week_end text,carry_right bigint,carry_left bigint
      )
      ON CONFLICT(member_id,account_position,week_start,week_end) DO UPDATE SET
        carry_right=EXCLUDED.carry_right,carry_left=EXCLUDED.carry_left,is_finalized=true`,
      [JSON.stringify(boundaryRows)]
    );

    stage = "verify_imported_state";
    const walletVerify=await db.query(
      "SELECT count(*)::int records,COALESCE(sum(get_admin_marketer_wallet_balance(id)),0)::numeric total FROM app_profiles WHERE id=ANY($1::text[]) AND role='marketer'",
      [sourceIds]
    );
    const bvVerify=await db.query(
      `SELECT count(*)::int records,
        count(*) FILTER(WHERE b.total_right=a.source_total_right AND b.total_left=a.source_total_left
                         AND b.carry_right=a.source_carry_right AND b.carry_left=a.source_carry_left)::int exact_rows
       FROM network_bv_opening_adjustments a
       JOIN network_bv_balances b ON b.member_id=a.member_id AND b.account_position=a.account_position
       WHERE a.source_upload_id=$1`,
      [UPLOAD_ID]
    );
    const placementsVerify=await db.query(
      "SELECT count(*)::int records,count(DISTINCT member_id)::int members FROM network_placements WHERE member_id=ANY($1::text[])",
      [sourceIds]
    );
    return res.json({
      ok:true,mode:"legacy_migration_applied",
      upload_id:UPLOAD_ID,source_agents:agents.length,source_admin_excluded:adminRows.length,
      existing_profiles_matched:Number(exact.rows[0]?.n||0),
      new_profiles_created:newProfiles.length,
      profiles_updated:profileRows.length,
      network_placements_added:placementInsert.rowCount||0,
      wallets_set_to_source_balance:walletRows.length,
      wallet_balance_verification:walletVerify.rows[0]||{},
      balance_history_records_source:balanceHistories.length,
      wallet_history_rows_inserted:Number(transactionInsert.rows[0]?.inserted||0),
      withdrawal_requests_source:withdrawals.length,
      withdrawal_requests_new:withdrawalMapRows.length,
      legacy_agent_history_records:agentHistories.length,
      transfer_history_records_archived:transfers.length,
      bv_opening_adjustment_rows:bvRows.length,
      bv_verification:bvVerify.rows[0]||{},
      network_placements_verification:placementsVerify.rows[0]||{},
      finalized_boundary_week_start:weekStart,
      finalized_boundary_week_end:weekEnd,
      finalized_boundary_rows:boundaryRows.length,
      historical_weekly_cheques_created:0,
      previous_settlement_check_amounts_preserved:true,
      historical_bv_inserted_as_sales:false,
      credentials_imported:false,
      expired_epins_imported:false
    });
  } catch (e) {
    return res.status(500).json({
      ok:false,error:"legacy_migration_apply_failed",
      stage,message:String(e?.message||e).slice(0,350),
      note:"The importer is idempotent; completed stages can be safely retried after correcting the reported stage."
    });
  }
}