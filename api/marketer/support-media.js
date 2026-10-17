import { storage } from "hatchable";
import crypto from "node:crypto";
import { requireNetworkUser } from "../../lib/network-auth.js";
export const access = "public";
export const methods = ["POST"];
const types = new Map([["image/jpeg","jpg"],["image/png","png"],["image/webp","webp"],["image/gif","gif"],["video/mp4","mp4"],["video/webm","webm"],["video/quicktime","mov"],["application/pdf","pdf"]]);
export default async function(req,res){
 const user=await requireNetworkUser(req,res);if(!user)return;
 try{
  const b=typeof req.body==="string"?JSON.parse(req.body||"{}"):(req.body||{});
  const mime=String(b.content_type||"").toLowerCase(),ext=types.get(mime);
  if(!ext)return res.status(415).json({ok:false,error:"unsupported_media_type"});
  const raw=String(b.data_base64||"").replace(/^data:[^,]+,/,"");
  if(!raw||raw.length>21_500_000)return res.status(413).json({ok:false,error:"file_too_large",max_bytes:15_000_000});
  const bytes=Buffer.from(raw,"base64");
  if(!bytes.length||bytes.length>15_000_000)return res.status(413).json({ok:false,error:"file_too_large",max_bytes:15_000_000});
  const key="support-chat/"+String(user.id)+"/"+crypto.randomUUID()+"."+ext;
  await storage.put(key,bytes,mime);
  return res.json({ok:true,attachment:{key,type:mime,name:String(b.name||("مرفق."+ext)).replace(/[\\/\r\n]/g,"_").slice(0,180),bytes:bytes.length}});
 }catch(e){console.error("marketer support attachment upload failed",e);return res.status(500).json({ok:false,error:"attachment_upload_failed"});}
}