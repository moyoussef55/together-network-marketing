import { db, storage } from "hatchable";
import { requireAdminSession } from "../../lib/admin-auth.js";
import crypto from "node:crypto";
export const access = "public";
export const methods = ["GET","POST","PUT","DELETE"];
async function mediaUrl(key){const value=String(key||"");if(value.startsWith("namecheap-events/"))return "https://marketing.together-v-egp.com/event-media?key="+encodeURIComponent(value);return storage.url(value)}
const allowed=new Map([["image/jpeg","jpg"],["image/png","png"],["image/webp","webp"],["image/gif","gif"],["video/mp4","mp4"],["video/webm","webm"],["video/quicktime","mov"]]);
const uploadName=(value,ext)=>String(value||("event."+ext)).replace(/[\\/\\r\\n]/g,"_").slice(0,180);
async function handleChunkedEventPost(req,res,b){
 const action=String(b.upload_action||"");
 if(!["upload_chunk","finalize_media","publish_uploaded"].includes(action))return null;
 if(action==="upload_chunk"){
  const uploadId=String(b.upload_id||"");
  if(!/^[a-f0-9-]{20,80}$/i.test(uploadId))return res.status(400).json({ok:false,error:"invalid_upload_id"});
  const index=Number(b.index);
  if(!Number.isSafeInteger(index)||index<0||index>10000)return res.status(400).json({ok:false,error:"invalid_chunk_index"});
  const raw=String(b.data_base64||"").replace(/^data:[^,]+,/,"");
  if(!raw)return res.status(400).json({ok:false,error:"empty_chunk"});
  const bytes=Buffer.from(raw,"base64");
  if(!bytes.length||bytes.length>4*1024*1024)return res.status(413).json({ok:false,error:"invalid_chunk_size"});
  await storage.put("network-events/.upload-"+uploadId+"-"+index+".part",bytes,"application/octet-stream");
  return res.json({ok:true,index,bytes:bytes.length});
 }
 if(action==="finalize_media"){
  const uploadId=String(b.upload_id||"");
  if(!/^[a-f0-9-]{20,80}$/i.test(uploadId))return res.status(400).json({ok:false,error:"invalid_upload_id"});
  const chunks=Number(b.chunks);
  if(!Number.isSafeInteger(chunks)||chunks<1||chunks>10001)return res.status(400).json({ok:false,error:"invalid_chunk_count"});
  const mime=String(b.content_type||"").split(";")[0].trim().toLowerCase(),ext=allowed.get(mime);
  if(!ext)return res.status(415).json({ok:false,error:"unsupported_media_type"});
  const keys=Array.from({length:chunks},(_,i)=>"network-events/.upload-"+uploadId+"-"+i+".part"),parts=[];
  for(let start=0;start<keys.length;start+=4){
   const batch=await Promise.all(keys.slice(start,start+4).map(async key=>{const part=await storage.get(key);return Buffer.from(part.buffer||[])}));
   if(batch.some(part=>!part.length))return res.status(400).json({ok:false,error:"missing_upload_chunk"});
   parts.push(...batch);
  }
  const bytes=Buffer.concat(parts);
  if(!bytes.length)return res.status(400).json({ok:false,error:"empty_media"});
  const key="network-events/"+crypto.randomUUID()+"."+ext;
  await storage.put(key,bytes,mime);
  await Promise.all(keys.map(async partKey=>{try{await storage.del(partKey)}catch(_){}}));
  return res.json({ok:true,media:{key,type:mime,name:uploadName(b.name,ext),bytes:bytes.length}});
 }
 const title=String(b.title||"").trim(),description=String(b.description||"").trim();
 const eventType=b.event_type==="upcoming"?"upcoming":"past",audience=b.audience==="public"?"public":"members",sectionTitle=String(b.section_title||"").trim();
 const eventDate=b.event_date?new Date(b.event_date):null,files=Array.isArray(b.media)?b.media:[];
 if(!title||title.length>180||!description||description.length>5000)return res.status(400).json({ok:false,error:"title_or_description_invalid"});
 if(eventDate&&!Number.isFinite(eventDate.getTime()))return res.status(400).json({ok:false,error:"invalid_event_date"});
 if(!files.length)return res.status(400).json({ok:false,error:"media_required"});
 for(const f of files){
  const mime=String(f.type||"").toLowerCase(),ext=allowed.get(mime),key=String(f.key||"");
  if(!ext||!new RegExp("^network-events/[a-f0-9-]{36}\\."+ext+"$","i").test(key)||!Number.isSafeInteger(Number(f.bytes))||Number(f.bytes)<1)
   return res.status(400).json({ok:false,error:"invalid_uploaded_media"});
 }
 let eventId=null;
 try{
  const first=files[0];
  const inserted=await db.query("INSERT INTO network_events(title,description,media_key,media_type,media_name,media_bytes,event_type,event_date,section_title,audience,is_visible) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE) RETURNING id,title,description,media_key,media_type,media_name,media_bytes,event_type,event_date,section_title,audience,is_visible,created_at",
   [title,description,first.key,first.type,uploadName(first.name,allowed.get(first.type)),Number(first.bytes),eventType,eventDate,sectionTitle,audience]);
  eventId=inserted.rows[0].id;
  for(const f of files.slice(1))await db.query("INSERT INTO network_event_media(event_id,media_key,media_type,media_name,media_bytes) VALUES($1,$2,$3,$4,$5)",[eventId,f.key,f.type,uploadName(f.name,allowed.get(f.type)),Number(f.bytes)]);
  const event={...inserted.rows[0],media_url:await mediaUrl(first.key),media_items:await Promise.all(files.map(async f=>({media_key:f.key,media_type:f.type,media_name:uploadName(f.name,allowed.get(f.type)),media_url:await mediaUrl(f.key)})))};
  return res.status(201).json({ok:true,event});
 }catch(err){
  if(eventId!==null){try{await db.query("DELETE FROM network_events WHERE id=$1",[eventId])}catch(_){}}
  await Promise.all(files.map(async f=>{try{await storage.del(f.key)}catch(_){}}));
  throw err;
 }
}
export default async function(req,res){
 if(!(await requireAdminSession(req,res)))return;
 if(req.method==="POST"){
  let posted;try{posted=typeof req.body==="string"?JSON.parse(req.body||"{}"):(req.body||{});}catch(_){posted={};}
  if(posted.upload_action){try{const result=await handleChunkedEventPost(req,res,posted);if(result)return result;}catch(e){console.error("admin events chunk upload failed",e);return res.status(500).json({ok:false,error:"event_upload_failed"});}}
 }
 if(req.method==="GET"){
  const rows=await db.query("SELECT id,title,description,media_key,media_type,media_name,media_bytes,event_type,event_date,section_title,is_visible,audience,created_at FROM network_events ORDER BY created_at DESC,id DESC");
  return res.json({ok:true,events:await Promise.all(rows.rows.map(async e=>{const extra=await db.query("SELECT media_key,media_type,media_name FROM network_event_media WHERE event_id=$1 ORDER BY id",[e.id]);const media_items=[{media_key:e.media_key,media_type:e.media_type,media_name:e.media_name},...extra.rows];return {...e,media_url:await mediaUrl(e.media_key),media_items:await Promise.all(media_items.map(async m=>({...m,media_url:await mediaUrl(m.media_key)})))};}))});
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