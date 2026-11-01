import { db, storage } from "hatchable";
import { requireNetworkUser } from "../../lib/network-auth.js";
export const access = "public";
export const methods = ["GET"];
async function mediaUrl(key){const value=String(key||"");if(value.startsWith("namecheap-events/"))return "https://marketing.together-v-egp.com/event-media?key="+encodeURIComponent(value);return storage.url(value)}
export default async function(req,res){
 const user=await requireNetworkUser(req,res);if(!user)return;
 const profile=await db.query("SELECT role,deleted_at,login_blocked,status FROM app_profiles WHERE id=$1 LIMIT 1",[user.id]);
 const p=profile.rows[0];
 if(!p||p.role!=="marketer")return res.status(403).json({ok:false,error:"marketer_only"});
 if(p.deleted_at||p.login_blocked||["blocked","deleted"].includes(String(p.status||"").toLowerCase()))return res.status(403).json({ok:false,error:"account_unavailable"});
 const rows=await db.query("SELECT id,title,description,media_key,media_type,media_name,media_bytes,event_type,event_date,section_title,is_visible,audience,created_at FROM network_events WHERE is_visible=TRUE ORDER BY CASE WHEN event_type='upcoming' THEN 0 ELSE 1 END,event_date ASC NULLS LAST,created_at DESC,id DESC");
 const events=await Promise.all(rows.rows.map(async e=>{const extra=await db.query("SELECT media_key,media_type,media_name FROM network_event_media WHERE event_id=$1 ORDER BY id",[e.id]);const media_items=[{media_key:e.media_key,media_type:e.media_type,media_name:e.media_name},...extra.rows];return {...e,media_url:await mediaUrl(e.media_key),media_items:await Promise.all(media_items.map(async m=>({...m,media_url:await mediaUrl(m.media_key)})))};}));
 return res.json({ok:true,events});
}