import { db } from "hatchable";
import { requireAdminSession } from "../../lib/admin-auth.js";
import { storage } from "hatchable";
const allowedTypes=new Set(["image/jpeg","image/png","image/webp","image/gif","video/mp4","video/webm","video/quicktime","application/pdf"]);
async function signedAttachments(value){const items=Array.isArray(value)?value:[];return Promise.all(items.map(async a=>({...a,url:await storage.url(a.key)})))}
export const access = "public";
export const methods = ["GET","POST"];
export default async function handler(req,res){
 if(!(await requireAdminSession(req,res)))return;
 if(req.method==="GET"){
  const q=String(req.query?.q||"").trim();
  const args=q?["%"+q+"%"]:[];
  const conversations=await db.query(`SELECT p.id AS marketer_id,
    COALESCE(NULLIF(p.display_name,''),NULLIF(concat_ws(' ',p.first_name,p.second_name,p.third_name,p.fourth_name),''),p.referral_code,'مسوق') AS name,
    p.referral_code, MAX(m.created_at) AS last_message_at,
    (SELECT COALESCE(NULLIF(message,''),CASE WHEN jsonb_array_length(attachments)>0 THEN '📎 مرفق' ELSE '' END) FROM marketer_support_messages x WHERE x.marketer_id=p.id ORDER BY x.id DESC LIMIT 1) AS last_message,
    COUNT(*) FILTER(WHERE m.sender_role='marketer' AND m.read_at IS NULL)::int AS unread
   FROM app_profiles p JOIN marketer_support_messages m ON m.marketer_id=p.id
   WHERE p.role='marketer' AND p.deleted_at IS NULL ${q?"AND (p.id ILIKE $1 OR p.referral_code ILIKE $1 OR p.display_name ILIKE $1 OR concat_ws(' ',p.first_name,p.second_name,p.third_name,p.fourth_name) ILIKE $1)":""}
   GROUP BY p.id,p.display_name,p.first_name,p.second_name,p.third_name,p.fourth_name,p.referral_code
   ORDER BY COUNT(*) FILTER(WHERE m.sender_role='marketer' AND m.read_at IS NULL) DESC,MAX(m.created_at) DESC LIMIT 300`,args);
  const total=await db.query("SELECT COUNT(*)::int AS unread FROM marketer_support_messages WHERE sender_role='marketer' AND read_at IS NULL");
  const selected=String(req.query?.marketer_id||"");
  let messages=[];
  if(selected){
   const ok=await db.query("SELECT 1 FROM app_profiles WHERE id=$1 AND role='marketer' AND deleted_at IS NULL",[selected]);
   if(!ok.rows.length)return res.status(404).json({ok:false,error:"marketer_not_found"});
   const rows=await db.query("SELECT id,sender_role,message,attachments,created_at,read_at FROM marketer_support_messages WHERE marketer_id=$1 ORDER BY id ASC LIMIT 500",[selected]);
   messages=await Promise.all(rows.rows.map(async m=>({...m,attachments:await signedAttachments(m.attachments)})));
   await db.query("UPDATE marketer_support_messages SET read_at=now() WHERE marketer_id=$1 AND sender_role='marketer' AND read_at IS NULL",[selected]);
  }
  return res.json({ok:true,conversations:conversations.rows,total_unread:Number(total.rows[0]?.unread||0),selected: selected||null,messages});
 }
 let b=req.body||{};if(typeof b==="string"){try{b=JSON.parse(b)}catch{return res.status(400).json({ok:false,error:"invalid_json"})}}
 const marketerId=String(b.marketer_id||"").trim(),message=String(b.message||"").trim(),attachments=Array.isArray(b.attachments)?b.attachments:[];
 if(!marketerId||(!message&&!attachments.length)||message.length>4000)return res.status(400).json({ok:false,error:"marketer_and_message_required"});
 if(attachments.length>5||attachments.some(a=>!a||typeof a.key!=="string"||!a.key.startsWith("support-chat/admin/")||!allowedTypes.has(String(a.type||""))||!String(a.name||"").trim()))return res.status(400).json({ok:false,error:"invalid_attachments"});
 const safe=attachments.map(a=>({key:a.key,type:a.type,name:String(a.name).slice(0,180),bytes:Number(a.bytes)||0}));
 const exists=await db.query("SELECT 1 FROM app_profiles WHERE id=$1 AND role='marketer' AND deleted_at IS NULL",[marketerId]);
 if(!exists.rows.length)return res.status(404).json({ok:false,error:"marketer_not_found"});
 const saved=await db.query("INSERT INTO marketer_support_messages(marketer_id,sender_role,sender_id,message,attachments,read_at) VALUES($1,'admin','admin',$2,$3::jsonb,now()) RETURNING id,sender_role,message,attachments,created_at,read_at",[marketerId,message||"",JSON.stringify(safe)]);
 return res.json({ok:true,message:{...saved.rows[0],attachments:await signedAttachments(saved.rows[0].attachments)}});
}