import { db, storage } from "hatchable";
import { requireNetworkUser } from "../../lib/network-auth.js";
export const access = "public";
export const methods = ["GET","POST"];
const body=req=>typeof req.body==="string"?JSON.parse(req.body||"{}"):(req.body||{});
export default async function(req,res){
 const user=await requireNetworkUser(req,res);if(!user)return;
 const profile=await db.query("SELECT role,deleted_at,login_blocked,status FROM app_profiles WHERE id=$1 LIMIT 1",[user.id]);
 const p=profile.rows[0];
 if(!p||p.role!=="marketer")return res.status(403).json({error:"marketer_only"});
 if(p.deleted_at||p.login_blocked||["blocked","deleted"].includes(String(p.status||"").toLowerCase()))return res.status(403).json({error:"account_unavailable"});
 if(req.method==="GET"){
  await db.query("WITH visible AS (SELECT id FROM member_messages WHERE recipient_id=$1 AND show_in_site=true ORDER BY created_at DESC LIMIT 100) UPDATE member_messages SET viewed_at=COALESCE(viewed_at,now()) WHERE id IN (SELECT id FROM visible) AND viewed_at IS NULL",[user.id]);
  const rows=await db.query("SELECT id,subject,message,created_at,viewed_at,read_at,media_key,media_type,send_push FROM member_messages WHERE recipient_id=$1 AND show_in_site=true ORDER BY created_at DESC LIMIT 100",[user.id]);
  const messages=await Promise.all(rows.rows.map(async m=>({...m,media_url:m.media_key?await storage.url(m.media_key):null})));
  const unread=await db.query("SELECT count(*)::int AS count FROM member_messages WHERE recipient_id=$1 AND show_in_site=true AND read_at IS NULL",[user.id]);
  return res.json({ok:true,messages,unread:Number(unread.rows[0]?.count||0)});
 }
 const b=body(req),id=String(b.id||"").trim();
 if(id==="all"){await db.query("UPDATE member_messages SET viewed_at=COALESCE(viewed_at,now()),read_at=COALESCE(read_at,now()) WHERE recipient_id=$1 AND show_in_site=true AND read_at IS NULL",[user.id]);return res.json({ok:true});}
 if(!id)return res.status(400).json({error:"message_id_required"});
 const r=await db.query("UPDATE member_messages SET viewed_at=COALESCE(viewed_at,now()),read_at=COALESCE(read_at,now()) WHERE id=$1 AND recipient_id=$2 AND show_in_site=true RETURNING id",[id,user.id]);
 return res.json({ok:true,updated:r.rowCount||r.rows.length});
}