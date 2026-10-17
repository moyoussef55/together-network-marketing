import { db, storage } from "hatchable";
import crypto from "node:crypto";
import { getNetworkUser } from "../../lib/network-auth.js";

export const access = "public";
export const methods = ["POST"];

const imageTypes = new Set(["image/jpeg","image/png","image/webp"]);
const audioTypes = new Set(["audio/webm","audio/ogg","audio/mp4","audio/mpeg","audio/wav","audio/x-wav","audio/aac"]);
const extensions = {"image/jpeg":"jpg","image/png":"png","image/webp":"webp","audio/webm":"webm","audio/ogg":"ogg","audio/mp4":"m4a","audio/mpeg":"mp3","audio/wav":"wav","audio/x-wav":"wav","audio/aac":"aac"};

export default async function(req,res){
  const user=await getNetworkUser(req);
  if(!user)return res.status(401).json({error:"login_required"});
  const admin=user.role==="admin" || req.user?.role==="admin" || req.user?.is_admin===true;
  if(!admin && user.role!=="marketer")return res.status(403).json({error:"forbidden"});
  const file=(req.files||[]).find(f=>f.field==="file");
  const kind=String(req.body?.kind||"").trim();
  if(!file || !["national_id_front","national_id_back","voice_recording","paper_contract","declaration_image"].includes(kind))
    return res.status(400).json({error:"file_and_kind_required"});
  const type=String(file.contentType||"").toLowerCase().split(";")[0].trim();
  const isImage=kind!=="voice_recording";
  if(isImage ? !imageTypes.has(type) : !audioTypes.has(type))
    return res.status(415).json({error:isImage?"unsupported_image_type":"unsupported_audio_type"});
  const limit=isImage?8*1024*1024:12*1024*1024;
  if(!file.buffer || file.buffer.length===0)return res.status(400).json({error:"empty_file"});
  if(file.buffer.length>limit)return res.status(413).json({error:isImage?"image_too_large":"audio_too_large"});
  const key="registration-media/"+user.id+"/"+kind+"/"+crypto.randomUUID()+"."+(extensions[type]||"bin");
  await storage.put(key,file.buffer,type);
  return res.status(201).json({ok:true,kind,storage_key:key});
}