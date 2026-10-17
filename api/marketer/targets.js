import { db } from "hatchable";
import { requireNetworkUser } from "../../lib/network-auth.js";
export const access = "public";
export const methods = ["GET"];
export default async function(req,res){
  const user=await requireNetworkUser(req,res);if(!user)return;
  const profile=await db.query("SELECT role,deleted_at,login_blocked,status FROM app_profiles WHERE id=$1 LIMIT 1",[user.id]);
  const p=profile.rows[0];
  if(!p||p.role!=="marketer")return res.status(403).json({ok:false,error:"marketer_only"});
  if(p.deleted_at||p.login_blocked||["blocked","deleted"].includes(String(p.status||"").toLowerCase()))return res.status(403).json({ok:false,error:"account_unavailable"});
  const r=await db.query("SELECT entity_id AS id, metadata->>'title' AS title, metadata->>'description' AS description, COALESCE((metadata->>'reward_amount')::numeric,0) AS reward_amount, created_at FROM audit_logs WHERE action='network_target_published' AND COALESCE((metadata->>'published')::boolean,TRUE)=TRUE ORDER BY created_at DESC");
  return res.json({ok:true,targets:r.rows});
}