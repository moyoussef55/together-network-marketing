import { db } from "hatchable";
import { requireAdminSession } from "../../lib/admin-auth.js";
export const access = "public";
export const methods = ["GET","POST"];
export default async function(req,res){
  if(!(await requireAdminSession(req,res))) return;
  if(req.method==="GET"){
    const r=await db.query("SELECT id,week_start,week_end,payload,created_at FROM admin_auto_update_notifications WHERE dismissed_at IS NULL ORDER BY created_at DESC LIMIT 1");
    return res.json({ok:true,notification:r.rows[0]||null});
  }
  let b=req.body||{};
  if(typeof b==="string"){try{b=JSON.parse(b)}catch{return res.status(400).json({ok:false,error:"invalid_json"})}}
  if(b.action!=="dismiss"||!Number.isInteger(Number(b.id))) return res.status(400).json({ok:false,error:"invalid_request"});
  await db.query("UPDATE admin_auto_update_notifications SET dismissed_at=now() WHERE id=$1 AND dismissed_at IS NULL",[Number(b.id)]);
  return res.json({ok:true,dismissed:true});
}