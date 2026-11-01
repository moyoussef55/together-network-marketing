import { db } from "hatchable";
import { requireNetworkUser } from "../../lib/network-auth.js";

export const access = "public";
export const methods = ["GET"];

export default async function handler(req,res){
  res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma","no-cache");
  res.setHeader("Expires","0");
  const user=await requireNetworkUser(req,res);
  if(!user)return;
  const uid=user.id;
  const requested=String(req.query?.member_id||uid).trim();
  const position=Number(req.query?.account_position||1);
  if(![1,2,3].includes(position)) return res.status(400).json({error:"invalid_account_position"});

  if(requested!==uid){
    // BV can be viewed for members in the user's own network, including uplines
    // so a marketer can inspect the root/upline card while viewing that network.
    const allowed=await db.query(`WITH RECURSIVE descendants AS (
      SELECT p.member_id::text AS member_id
        FROM network_placements p WHERE p.owner_marketer_id=$1
      UNION
      SELECT p2.member_id::text
        FROM network_placements p2 JOIN descendants d ON p2.owner_marketer_id::text=d.member_id
    ),
    ancestors AS (
      SELECT p.owner_marketer_id::text AS member_id
        FROM network_placements p WHERE p.member_id::text=$1
      UNION
      SELECT p2.owner_marketer_id::text
        FROM network_placements p2 JOIN ancestors a ON p2.member_id::text=a.member_id
    )
    SELECT 1
     WHERE $2::text IN (SELECT member_id FROM descendants)
        OR $2::text IN (SELECT member_id FROM ancestors)
     LIMIT 1`,[uid,requested]);
    if(!allowed.rows.length) return res.status(403).json({error:"network_access_denied"});
  }

  const balance=await db.query(`SELECT member_id,account_position,total_right,total_left,carry_right,carry_left,updated_at
    FROM network_bv_balances WHERE member_id=$1 AND account_position=$2`,[requested,position]);
  const hasLiveBalance=balance.rows.length>0;
  const b=balance.rows[0]||{member_id:requested,account_position:position,total_right:0,total_left:0,carry_right:0,carry_left:0};
  const legacy=await db.query(`
    SELECT s.payload
      FROM legacy_import_source_records s
      LEFT JOIN app_profiles p
        ON (NULLIF(s.payload->>'id','') IS NOT NULL AND p.legacy_member_code=s.payload->>'id')
        OR (NULLIF(s.payload->>'email','') IS NOT NULL AND lower(COALESCE(p.email,''))=lower(s.payload->>'email'))
     WHERE s.collection_name='agents' AND (s.source_id=$1 OR p.id=$1)
     ORDER BY CASE WHEN s.source_id=$1 THEN 0 WHEN p.legacy_member_code=s.payload->>'id' THEN 1 ELSE 2 END
     LIMIT 1
  `,[requested]);
  const legacyPayload=legacy.rows[0]?.payload||{};
  const legacyBv={
    1:{right:Number(legacyPayload.rightPv||0),left:Number(legacyPayload.leftPv||0),carry_right:Number(legacyPayload.carryRight||0),carry_left:Number(legacyPayload.carryLeft||0)},
    2:{right:Number(legacyPayload.rightPv2||0),left:Number(legacyPayload.leftPv2||0),carry_right:Number(legacyPayload.carryRight2||0),carry_left:Number(legacyPayload.carryLeft2||0)},
    3:{right:Number(legacyPayload.rightPv3||0),left:Number(legacyPayload.leftPv3||0),carry_right:Number(legacyPayload.carryRight3||0),carry_left:Number(legacyPayload.carryLeft3||0)}
  }[position];
  // Keep live ledger totals when present; fall back to the uploaded pre-merge BV
  // values for positions that have not yet been migrated into the live BV tables.
  if(!hasLiveBalance){
    b.total_right=legacyBv.right;
    b.total_left=legacyBv.left;
    b.carry_right=legacyBv.carry_right;
    b.carry_left=legacyBv.carry_left;
  }

  // Before the weekly update, Carry must show ALL unmatched-yet-unsettled BV:
  // persisted carry from the previous update plus every new BV since that update.
  // Do not subtract matches here. Matching and check issuance happen only in the
  // weekly settlement job; that job then persists the remainder as the next carry.
  const carryView=await db.query(`
    WITH last_settlement AS (
      SELECT week_end,carry_right,carry_left
        FROM network_bv_settlements
       WHERE member_id=$1 AND account_position=$2
       ORDER BY week_end DESC,week_start DESC,id DESC LIMIT 1
    ), cycle_start AS (
      SELECT COALESCE(
        (SELECT (week_end::timestamp AT TIME ZONE 'Africa/Cairo') FROM last_settlement),
        ((date_trunc('week',timezone('Africa/Cairo',now()))::date - 2)::timestamp AT TIME ZONE 'Africa/Cairo')
      ) AS start_at
    ), period_bv AS (
      SELECT COALESCE(SUM(bv) FILTER(WHERE side='right'),0)::bigint AS right_bv,
             COALESCE(SUM(bv) FILTER(WHERE side='left'),0)::bigint AS left_bv
        FROM network_bv_ledger,cycle_start
       WHERE upline_member_id=$1 AND account_position=$2 AND sale_at >= cycle_start.start_at
    )
    SELECT COALESCE((SELECT carry_right FROM last_settlement),$3::bigint,0)+right_bv AS right_bv,
           COALESCE((SELECT carry_left FROM last_settlement),$4::bigint,0)+left_bv AS left_bv
      FROM period_bv
  `,[requested,position,Number(b.carry_right||0),Number(b.carry_left||0)]);
  if(carryView.rows[0]){
    b.carry_right=Number(carryView.rows[0].right_bv||0);
    b.carry_left=Number(carryView.rows[0].left_bv||0);
  }

  const checks=await db.query(`SELECT id,week_start,week_end,right_bv,left_bv,matched_bv,check_amount,carry_right,carry_left,settled_at
    FROM network_bv_settlements WHERE member_id=$1 AND account_position=$2 ORDER BY week_end DESC,week_start DESC,id DESC LIMIT 12`,[requested,position]);

  const recent=await db.query(`SELECT order_id,bv,side,sale_at,source_member_id FROM network_bv_ledger
    WHERE upline_member_id=$1 AND account_position=$2 ORDER BY sale_at DESC LIMIT 100`,[requested,position]);

  return res.json({ok:true,balance:b,checks:checks.rows,recent_sales:recent.rows});
}