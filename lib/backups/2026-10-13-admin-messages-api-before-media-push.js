import { db } from "hatchable";
import { requireAdminSession } from "../../lib/admin-auth.js";
export const access = "public";
export const methods = ["GET","POST"];
const clean=v=>String(v??"").trim();
const body=req=>typeof req.body==="string"?JSON.parse(req.body||"{}"):(req.body||{});
export default async function(req,res){if(!(await requireAdminSession(req,res)))return;
 if(req.method==="GET"){
  const q=clean(req.query?.q);
  const params=q?["%"+q+"%"]:[];
  const rows=await db.query(`SELECT id,referral_code,display_name,first_name,second_name,third_name,fourth_name,email,phone FROM app_profiles WHERE role='marketer' AND deleted_at IS NULL ${q?"AND (id ILIKE $1 OR referral_code ILIKE $1 OR display_name ILIKE $1 OR concat_ws(' ',first_name,second_name,third_name,fourth_name) ILIKE $1)":""} ORDER BY created_at DESC LIMIT 300`,params);
  const recent=await db.query("SELECT m.id,m.subject,m.message,m.created_at,m.recipient_id,p.display_name,p.referral_code FROM member_messages m JOIN app_profiles p ON p.id=m.recipient_id ORDER BY m.created_at DESC LIMIT 30");
  return res.json({ok:true,marketers:rows.rows.map(x=>({...x,display_name:x.display_name||[x.first_name,x.second_name,x.third_name,x.fourth_name].filter(Boolean).join(" ")})),recent:recent.rows});
 }
 const b=body(req),subject=clean(b.subject).slice(0,180),message=clean(b.message).slice(0,10000),mode=clean(b.mode),target=clean(b.recipient_id);
 if(!message)return res.status(400).json({error:"message_required"});
 if(mode==="private"){
  if(!target)return res.status(400).json({error:"recipient_required"});
  const r=await db.query("SELECT id FROM app_profiles WHERE role='marketer' AND deleted_at IS NULL AND (id=$1 OR referral_code=$1) LIMIT 1",[target]);
  if(!r.rows.length)return res.status(404).json({error:"marketer_not_found"});
  await db.query("INSERT INTO member_messages(recipient_id,sender_id,subject,message) VALUES($1,$2,$3,$4)",[r.rows[0].id,req.user?.id||null,subject,message]);
  return res.json({ok:true,sent:1,mode:"private"});
 }
 if(mode!=="all")return res.status(400).json({error:"invalid_mode"});
 const r=await db.query("INSERT INTO member_messages(recipient_id,sender_id,subject,message) SELECT id,$1,$2,$3 FROM app_profiles WHERE role='marketer' AND deleted_at IS NULL RETURNING id",[req.user?.id||null,subject,message]);
 return res.json({ok:true,sent:r.rows.length,mode:"all"});
}