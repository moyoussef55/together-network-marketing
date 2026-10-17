import { db } from "hatchable";
import { requireNetworkUser } from "../../lib/network-auth.js";
export const access = "public";
export const methods = ["GET","POST"];
const body=req=>typeof req.body==="string"?JSON.parse(req.body||"{}"):(req.body||{});
export default async function(req,res){
 const user=await requireNetworkUser(req,res); if(!user)return;
 const profile=await db.query("SELECT role,deleted_at,login_blocked,status FROM app_profiles WHERE id=$1 LIMIT 1",[user.id]);
 const p=profile.rows[0];
 if(!p||p.role!=="marketer")return res.status(403).json({error:"marketer_only"});
 if(p.deleted_at||p.login_blocked||["blocked","deleted"].includes(String(p.status||"").toLowerCase()))return res.status(403).json({error:"account_unavailable"});
 if(req.method==="GET"){
  const rows=await db.query("SELECT id,subject,message,created_at,read_at FROM member_messages WHERE recipient_id=$1 ORDER BY created_at DESC LIMIT 100",[user.id]);
  const unread=await db.query("SELECT count(*)::int AS count FROM member_messages WHERE recipient_id=$1 AND read_at IS NULL",[user.id]);
  return res.json({ok:true,messages:rows.rows,unread:Number(unread.rows[0]?.count||0)});
 }
 const b=body(req),id=String(b.id||"").trim();
 if(id==="all"){await db.query("UPDATE member_messages SET read_at=now() WHERE recipient_id=$1 AND read_at IS NULL",[user.id]);return res.json({ok:true});}
 if(!id)return res.status(400).json({error:"message_id_required"});
 const r=await db.query("UPDATE member_messages SET read_at=now() WHERE id=$1 AND recipient_id=$2 RETURNING id",[id,user.id]);
 return res.json({ok:true,updated:r.rowCount||r.rows.length});
}