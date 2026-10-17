import { db } from "hatchable";
import { requireNetworkUser } from "../../lib/network-auth.js";
export const access = "public";
export const methods = ["GET"];
export default async function handler(req,res){
 const user=await requireNetworkUser(req,res); if(!user)return;
 const page=Math.max(1,Math.min(100000,Number.parseInt(req.query?.page||"1",10)||1));
 const limit=20,offset=(page-1)*limit;
 const team=await db.query(`WITH RECURSIVE downline AS (
   SELECT p.member_id, 1 AS depth FROM network_placements p WHERE p.owner_marketer_id=$1
   UNION ALL
   SELECT p.member_id, d.depth+1 FROM network_placements p JOIN downline d ON p.owner_marketer_id=d.member_id
 )
 SELECT s.id,s.member_id,s.account_position,s.week_start,s.week_end,s.check_amount,s.settled_at,
        COALESCE(NULLIF(pr.display_name,''),NULLIF(concat_ws(' ',pr.first_name,pr.second_name,pr.third_name,pr.fourth_name),''),pr.referral_code,'مسوق') AS name,
        pr.referral_code, d.depth
 FROM downline d
 JOIN app_profiles pr ON pr.id=d.member_id AND pr.role='marketer'
 JOIN network_bv_settlements s ON s.member_id=d.member_id AND s.check_amount>0
 WHERE pr.deleted_at IS NULL
 ORDER BY s.week_end DESC,s.settled_at DESC,name ASC,s.account_position ASC
 LIMIT $2 OFFSET $3`,[user.id,limit,offset]);
 const count=await db.query(`WITH RECURSIVE downline AS (
   SELECT p.member_id FROM network_placements p WHERE p.owner_marketer_id=$1
   UNION
   SELECT p.member_id FROM network_placements p JOIN downline d ON p.owner_marketer_id=d.member_id
 )
 SELECT COUNT(*)::int AS total FROM downline d JOIN app_profiles pr ON pr.id=d.member_id AND pr.role='marketer' AND pr.deleted_at IS NULL
 JOIN network_bv_settlements s ON s.member_id=d.member_id AND s.check_amount>0`,[user.id]);
 const total=Number(count.rows[0]?.total||0);
 return res.json({ok:true,page,limit,total,pages:Math.max(1,Math.ceil(total/limit)),checks:team.rows.map(r=>({...r,check_amount:Number(r.check_amount||0),account_position:Number(r.account_position),depth:Number(r.depth)}))});
}