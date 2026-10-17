import { db } from "hatchable";
import { requireNetworkUser } from "../../lib/network-auth.js";
import { storage } from "hatchable";
const allowedTypes=new Set(["image/jpeg","image/png","image/webp","image/gif","video/mp4","video/webm","video/quicktime","application/pdf"]);
async function signedAttachments(value){const items=Array.isArray(value)?value:[];return Promise.all(items.map(async a=>({...a,url:await storage.url(a.key)})))}
export const access = "public";
export const methods = ["GET","POST"];
export default async function handler(req,res){
 const user=await requireNetworkUser(req,res); if(!user)return;
 if(req.method==="GET"){
  const rows=await db.query(`SELECT id,sender_role,message,attachments,created_at,read_at FROM marketer_support_messages WHERE marketer_id=$1 ORDER BY id ASC LIMIT 500`,[user.id]);
  await db.query(`UPDATE marketer_support_messages SET read_at=now() WHERE marketer_id=$1 AND sender_role='admin' AND read_at IS NULL`,[user.id]);
  const messages=await Promise.all(rows.rows.map(async m=>({...m,attachments:await signedAttachments(m.attachments)})));
  return res.json({ok:true,messages});
 }
 let b=req.body||{}; if(typeof b==="string"){try{b=JSON.parse(b)}catch{return res.status(400).json({ok:false,error:"invalid_json"})}}
 const message=String(b.message||"").trim(),attachments=Array.isArray(b.attachments)?b.attachments:[];
 if((!message&&!attachments.length)||message.length>4000)return res.status(400).json({ok:false,error:"message_or_attachment_required"});
 if(attachments.length>5||attachments.some(a=>!a||typeof a.key!=="string"||!(a.key.startsWith("support-chat/"+String(user.id)+"/")||a.key.startsWith("support-chat/admin/"))||!allowedTypes.has(String(a.type||""))||!String(a.name||"").trim()))return res.status(400).json({ok:false,error:"invalid_attachments"});
 const safe=attachments.map(a=>({key:a.key,type:a.type,name:String(a.name).slice(0,180),bytes:Number(a.bytes)||0}));
 const saved=await db.query(`INSERT INTO marketer_support_messages(marketer_id,sender_role,sender_id,message,attachments) VALUES($1,'marketer',$1,$2,$3::jsonb) RETURNING id,sender_role,message,attachments,created_at,read_at`,[user.id,message||"",JSON.stringify(safe)]);
 return res.json({ok:true,message:{...saved.rows[0],attachments:await signedAttachments(saved.rows[0].attachments)}});
}