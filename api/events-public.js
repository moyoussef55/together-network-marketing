import { db, storage } from "hatchable";
export const access = "public";
export const methods = ["GET"];
async function mediaUrl(key){const value=String(key||"");if(value.startsWith("namecheap-events/"))return "https://marketing.together-v-egp.com/event-media?key="+encodeURIComponent(value);return storage.url(value)}
export default async function(req,res){
 if(req.method!=="GET")return res.status(405).json({ok:false,error:"method_not_allowed"});
 try{
  const rows=await db.query("SELECT id,title,description,media_key,media_type,media_name,event_type,event_date,section_title,created_at FROM network_events WHERE is_visible=TRUE AND audience='public' ORDER BY CASE WHEN event_type='upcoming' THEN 0 ELSE 1 END,event_date ASC NULLS LAST,created_at DESC,id DESC");
  const events=await Promise.all(rows.rows.map(async e=>{const extra=await db.query("SELECT media_key,media_type,media_name FROM network_event_media WHERE event_id=$1 ORDER BY id",[e.id]);const media_items=[{media_key:e.media_key,media_type:e.media_type,media_name:e.media_name},...extra.rows];return {...e,media_url:await mediaUrl(e.media_key),media_items:await Promise.all(media_items.map(async m=>({...m,media_url:await mediaUrl(m.media_key)})))};}));
  return res.json({ok:true,events});
 }catch(e){console.error("public events failed",e);return res.status(500).json({ok:false,error:"events_unavailable"});}
}