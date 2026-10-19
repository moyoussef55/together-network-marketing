import { storage, db } from "hatchable";
import crypto from "node:crypto";
import { requireNetworkUser } from "../../lib/network-auth.js";
export const access = "public";
export const methods = ["GET","POST"];
const types = new Map([["image/jpeg","jpg"],["image/png","png"],["image/webp","webp"],["image/gif","gif"],["video/mp4","mp4"],["video/webm","webm"],["video/quicktime","mov"],["application/pdf","pdf"],["audio/webm","webm"],["audio/mp4","m4a"],["audio/ogg","ogg"],["audio/mpeg","mp3"]]);

function normalizeMime(value,name){
 let mime=String(value||"").split(";")[0].trim().toLowerCase();
 const ext=String(name||"").toLowerCase().match(/\.([a-z0-9]{1,10})$/)?.[1]||"";
 const byExt={jpg:"image/jpeg",jpeg:"image/jpeg",png:"image/png",webp:"image/webp",gif:"image/gif",avif:"image/avif",heic:"image/heic",heif:"image/heif",bmp:"image/bmp",tif:"image/tiff",tiff:"image/tiff",svg:"image/svg+xml",mp4:"video/mp4",webm:"video/webm",mov:"video/quicktime",m4v:"video/x-m4v",avi:"video/x-msvideo",mkv:"video/x-matroska","3gp":"video/3gpp",pdf:"application/pdf",mp3:"audio/mpeg",m4a:"audio/mp4",ogg:"audio/ogg",wav:"audio/wav",aac:"audio/aac",flac:"audio/flac"};
 if((!mime||mime==="application/octet-stream")&&byExt[ext])mime=byExt[ext];
 return types.has(mime)||mime==="application/pdf"||/^(image|video|audio)\/[a-z0-9.+-]+$/.test(mime)?mime:"";
}
function extensionFor(mime,name){
 const known=types.get(mime);if(known)return known;
 const ext=String(name||"").toLowerCase().match(/\.([a-z0-9]{1,10})$/)?.[1];
 if(ext)return ext;
 return mime==="application/pdf"?"pdf":mime.startsWith("image/")?"img":mime.startsWith("video/")?"video":"audio";
}
function supportedMime(mime){return types.has(mime)||mime==="application/pdf"||/^(image|video|audio)\/[a-z0-9.+-]+$/.test(String(mime||""));}
function safeUploadName(value,ext){return String(value||("مرفق."+ext)).replace(/[\\/\r\n]/g,"_").slice(0,180)||("مرفق."+ext);}
export default async function(req,res){
 const user=await requireNetworkUser(req,res);if(!user)return;

 if(req.method==="GET"){
  try{
   const key=String(req.query?.key||"");
   if(!key.startsWith("support-chat/"))return res.status(404).json({ok:false,error:"media_not_found"});
   const linked=await db.query("SELECT x.att->>'type' AS type FROM marketer_support_messages m CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(m.attachments)='array' THEN m.attachments ELSE '[]'::jsonb END) AS x(att) WHERE m.marketer_id=$1 AND x.att->>'key'=$2 LIMIT 1",[user.id,key]);
   if(!linked.rows.length||!supportedMime(String(linked.rows[0].type||"")))return res.status(404).json({ok:false,error:"media_not_found"});
   const mime=String(linked.rows[0].type);
   if(!mime.startsWith("audio/")){res.setHeader("Cache-Control","private, no-store");res.setHeader("Location",await storage.url(key));return res.status(302).end();}
   const stored=await storage.get(key),all=Buffer.from(stored.buffer||[]);
   if(!all.length)return res.status(404).json({ok:false,error:"audio_not_found"});
   let start=0,end=all.length-1,status=200;
   const range=String(req.headers?.range||"").trim();
   if(range){
    const m=/^bytes=(\d*)-(\d*)$/.exec(range);
    if(!m||(!m[1]&&!m[2])){res.setHeader("Content-Range","bytes */"+all.length);return res.status(416).end()}
    if(!m[1]){const suffix=Number(m[2]);if(!suffix){res.setHeader("Content-Range","bytes */"+all.length);return res.status(416).end()}start=Math.max(0,all.length-suffix)}
    else start=Number(m[1]);
    if(m[1]&&m[2])end=Math.min(end,Number(m[2]));
    if(start>=all.length||start>end){res.setHeader("Content-Range","bytes */"+all.length);return res.status(416).end()}
    status=206;
   }
   const output=all.subarray(start,end+1);
   res.setHeader("Content-Type",mime);res.setHeader("Content-Length",String(output.length));res.setHeader("Accept-Ranges","bytes");res.setHeader("Cache-Control","private, no-store");res.setHeader("X-Content-Type-Options","nosniff");
   if(status===206)res.setHeader("Content-Range","bytes "+start+"-"+end+"/"+all.length);
   return res.status(status).end(output);
  }catch(e){console.error("marketer support audio read failed",e);return res.status(500).json({ok:false,error:"audio_unavailable"})}
 }
 try{
  const b=typeof req.body==="string"?JSON.parse(req.body||"{}"):(req.body||{});
  const action=String(b.action||"");
  const uploadId=String(b.upload_id||"");
  const prefix="support-chat/"+String(user.id)+"/";
  const tempPrefix=prefix+".upload-"+uploadId+"-";
  if(action==="chunk"){
   if(!/^[a-zA-Z0-9_-]{1,80}$/.test(uploadId))return res.status(400).json({ok:false,error:"invalid_upload_id"});
   const index=Number(b.index);
   if(!Number.isSafeInteger(index)||index<0)return res.status(400).json({ok:false,error:"invalid_chunk_index"});
   const raw=String(b.data_base64||"").replace(/^data:[^,]+,/,"");
   if(!raw)return res.status(400).json({ok:false,error:"empty_chunk"});
   const bytes=Buffer.from(raw,"base64");
   if(!bytes.length||bytes.length>4*1024*1024)return res.status(413).json({ok:false,error:"invalid_chunk_size"});
   await storage.put(tempPrefix+index+".part",bytes,"application/octet-stream");
   return res.json({ok:true,index,bytes:bytes.length});
  }
  if(action==="finalize"){
   if(!/^[a-zA-Z0-9_-]{1,80}$/.test(uploadId))return res.status(400).json({ok:false,error:"invalid_upload_id"});
   const chunks=Number(b.chunks);
   if(!Number.isSafeInteger(chunks)||chunks<1)return res.status(400).json({ok:false,error:"invalid_chunk_count"});
   const mime=normalizeMime(b.content_type,b.name),ext=mime?extensionFor(mime,b.name):"";
   if(!mime||!ext)return res.status(415).json({ok:false,error:"unsupported_media_type"});
   const partKeys=Array.from({length:chunks},(_,i)=>tempPrefix+i+".part");
   const parts=[];
   // Read up to four chunks at once to reduce finalization latency without creating a large request burst.
   for(let start=0;start<partKeys.length;start+=4){
    const batch=await Promise.all(partKeys.slice(start,start+4).map(async partKey=>{
     const part=await storage.get(partKey);
     return Buffer.from(part.buffer||[]);
    }));
    if(batch.some(bytes=>!bytes.length))return res.status(400).json({ok:false,error:"missing_upload_chunk"});
    parts.push(...batch);
   }
   const all=Buffer.concat(parts);
   if(!all.length)return res.status(400).json({ok:false,error:"empty_file"});
   const key=prefix+crypto.randomUUID()+"."+ext;
   await storage.put(key,all,mime);
   await Promise.all(partKeys.map(async k=>{try{await storage.del(k)}catch(e){}}));
   return res.json({ok:true,attachment:{key,type:mime,name:safeUploadName(b.name,ext),bytes:all.length}});
  }
  const mime=normalizeMime(b.content_type,b.name),ext=mime?extensionFor(mime,b.name):"";
  if(!mime||!ext)return res.status(415).json({ok:false,error:"unsupported_media_type"});
  const raw=String(b.data_base64||"").replace(/^data:[^,]+,/,"");
  if(!raw)return res.status(400).json({ok:false,error:"empty_file"});
  const bytes=Buffer.from(raw,"base64");
  if(!bytes.length)return res.status(400).json({ok:false,error:"empty_file"});
  const key=prefix+crypto.randomUUID()+"."+ext;
  await storage.put(key,bytes,mime);
  return res.json({ok:true,attachment:{key,type:mime,name:safeUploadName(b.name,ext),bytes:bytes.length}});
 }catch(e){console.error("marketer support attachment upload failed",e);return res.status(500).json({ok:false,error:"attachment_upload_failed"});}
}