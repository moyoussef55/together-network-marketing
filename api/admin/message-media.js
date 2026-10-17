import { storage } from "hatchable";
import crypto from "node:crypto";
import { requireAdminSession } from "../../lib/admin-auth.js";
export const access = "public";
export const methods = ["POST"];
const allowed = new Map([
 ["image/jpeg","jpg"],["image/png","png"],["image/webp","webp"],["image/gif","gif"],
 ["video/mp4","mp4"],["video/webm","webm"],["video/quicktime","mov"]
]);
export default async function(req,res){
 if(!(await requireAdminSession(req,res)))return;
 try{
  const b=typeof req.body==="string"?JSON.parse(req.body||"{}"):(req.body||{});
  const mime=String(b.content_type||"").toLowerCase(),ext=allowed.get(mime);
  if(!ext)return res.status(415).json({error:"unsupported_media_type"});
  const raw=String(b.data_base64||"").replace(/^data:[^,]+,/, "");
  if(!raw||raw.length>17_000_000)return res.status(413).json({error:"media_too_large",max_bytes:12_000_000});
  const bytes=Buffer.from(raw,"base64");
  if(!bytes.length||bytes.length>12_000_000)return res.status(413).json({error:"media_too_large",max_bytes:12_000_000});
  const key="member-messages/"+crypto.randomUUID()+"."+ext;
  await storage.put(key,bytes,mime);
  return res.json({ok:true,media_key:key,media_type:mime,bytes:bytes.length});
 }catch(e){console.error("admin message media upload failed",e);return res.status(500).json({error:"media_upload_failed"});}
}