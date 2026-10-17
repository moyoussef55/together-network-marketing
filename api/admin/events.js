import { db, storage } from "hatchable";
import { requireAdminSession } from "../../lib/admin-auth.js";
import crypto from "node:crypto";
export const access = "public";
export const methods = ["GET","POST","PUT","DELETE"];
const allowed=new Map([["image/jpeg","jpg"],["image/png","png"],["image/webp","webp"],["image/gif","gif"],["video/mp4","mp4"],["video/webm","webm"],["video/quicktime","mov"]]);
export default async function(req,res){
 if(!(await requireAdminSession(req,res)))return;
 if(req.method==="GET"){
  const rows=await db.query("SELECT id,title,description,media_key,media_type,media_name,media_bytes,event_type,event_date,section_title,is_visible,audience,created_at FROM network_events ORDER BY created_at DESC,id DESC");
  return res.json({ok:true,events:await Promise.all(rows.rows.map(async e=>{const extra=await db.query("SELECT media_key,media_type,media_name FROM network_event_media WHERE event_id=$1 ORDER BY id",[e.id]);const media_items=[{media_key:e.media_key,media_type:e.media_type,media_name:e.media_name},...extra.rows];return {...e,media_url:await storage.url(e.media_key),media_items:await Promise.all(media_items.map(async m=>({...m,media_url:await storage.url(m.media_key)})))};}))});
 }
 if(req.method==="PUT"){
  const b=typeof req.body==="string"?JSON.parse(req.body||"{}"):(req.body||{}),id=Number(b.id);
  if(!Number.isInteger(id)||id<1)return res.status(400).json({ok:false,error:"event_id_required"});
  const title=String(b.title||"").trim(),description=String(b.description||"").trim(),eventType=b.event_type==="upcoming"?"upcoming":"past",audience=b.audience==="public"?"public":"members",sectionTitle=String(b.section_title||"").trim(),eventDate=b.event_date?new Date(b.event_date):null;
  if(!title||title.length>180||!description||description.length>5000)return res.status(400).json({ok:false,error:"title_or_description_invalid"});
  if(eventDate&&!Number.isFinite(eventDate.getTime()))return res.status(400).json({ok:false,error:"invalid_event_date"});
  const visible=b.is_visible!==false;
  const r=await db.query("UPDATE network_events SET title=$2,description=$3,event_type=$4,event_date=$5,section_title=$6,audience=$7,is_visible=$8,updated_at=now() WHERE id=$1 RETURNING id,title,description,event_type,event_date,section_title,audience,is_visible",[id,title,description,eventType,eventDate,sectionTitle,audience,visible]);
  if(!r.rows.length)return res.status(404).json({ok:false,error:"event_not_found"});
  return res.json({ok:true,event:r.rows[0]});
 }
 if(req.method==="DELETE"){
  const b=typeof req.body==="string"?JSON.parse(req.body||"{}"):(req.body||{}),id=Number(b.id);
  if(!Number.isInteger(id)||id<1)return res.status(400).json({ok:false,error:"event_id_required"});
  const r=await db.query("DELETE FROM network_events WHERE id=$1 RETURNING media_key",[id]);
  if(!r.rows.length)return res.status(404).json({ok:false,error:"event_not_found"});
  await storage.del(r.rows[0].media_key);
  return res.json({ok:true});
 }
 try{
  const b=req.body||{},title=String(b.title||"").trim(),description=String(b.description||"").trim(),eventType=b.event_type==="upcoming"?"upcoming":"past",audience=b.audience==="public"?"public":"members",sectionTitle=String(b.section_title||"").trim(),eventDate=b.event_date?new Date(b.event_date):null,files=(req.files||[]).filter(f=>f.field==="media"),file=files[0];
  if(!title||title.length>180||!description||description.length>5000)return res.status(400).json({ok:false,error:"title_or_description_invalid"}); if(eventDate&&!Number.isFinite(eventDate.getTime()))return res.status(400).json({ok:false,error:"invalid_event_date"});
  if(!file)return res.status(400).json({ok:false,error:"media_required"});
  const mime=String(file.contentType||"").toLowerCase(),ext=allowed.get(mime);
  if(!ext)return res.status(415).json({ok:false,error:"unsupported_media_type"});
  if(!file.buffer?.length)return res.status(400).json({ok:false,error:"empty_media"});
  const bytes=file.buffer;
  const key="network-events/"+crypto.randomUUID()+"."+ext;
  await storage.put(key,bytes,mime);
  const name=String(file.filename||("event."+ext)).replace(/[\\/\r\n]/g,"_").slice(0,180);
  try{
   const r=await db.query("INSERT INTO network_events(title,description,media_key,media_type,media_name,media_bytes,event_type,event_date,section_title,audience,is_visible) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE) RETURNING id,title,description,media_key,media_type,media_name,media_bytes,event_type,event_date,section_title,audience,is_visible,created_at",[title,description,key,mime,name,bytes.length,eventType,eventDate,sectionTitle,audience]);
   for(const extra of files.slice(1)){const extraMime=String(extra.contentType||"").toLowerCase(),extraExt=allowed.get(extraMime);if(!extraExt||!extra.buffer?.length)throw new Error("invalid_extra_media");const extraKey="network-events/"+crypto.randomUUID()+"."+extraExt;await storage.put(extraKey,extra.buffer,extraMime);const extraName=String(extra.filename||("event."+extraExt)).replace(/[\\/\r\n]/g,"_").slice(0,180);await db.query("INSERT INTO network_event_media(event_id,media_key,media_type,media_name,media_bytes) VALUES($1,$2,$3,$4,$5)",[r.rows[0].id,extraKey,extraMime,extraName,extra.buffer.length]);}const event={...r.rows[0],media_url:await storage.url(key)};
   return res.status(201).json({ok:true,event});
  }catch(e){await storage.del(key);throw e}
 }catch(e){console.error("admin events save failed",e);return res.status(500).json({ok:false,error:"event_save_failed"});}
}