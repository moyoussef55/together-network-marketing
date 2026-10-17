import { db, config, storage } from "hatchable";
import { requireAdminSession } from "../../lib/admin-auth.js";
export const access = "public";
export const methods = ["GET","POST"];
const clean=v=>String(v??"").trim();
const body=req=>typeof req.body==="string"?JSON.parse(req.body||"{}"):(req.body||{});
async function optionalConfig(name){try{return String(await config.get(name)||"").trim()}catch{return ""}}
async function signedMedia(rows){return Promise.all(rows.map(async row=>({...row,media_url:row.media_key?await storage.url(row.media_key):null})))}
async function sendPushToRecipients(ids,subject,message){
 const appId=await optionalConfig("ONESIGNAL_APP_ID"),key=await optionalConfig("ONESIGNAL_REST_API_KEY");
 if(!appId||!key)return {sent:0,warning:"push_not_configured"};
 const text=String(message||"تم إرسال مرفق جديد إليك").slice(0,4000);
 const payload={app_id:appId,target_channel:"push",include_aliases:{external_id:ids.map(String)},headings:{en:subject||"Together Network",ar:subject||"رسالة من إدارة Together"},contents:{en:text,ar:text},url:"https://together-network.hatchable.site/marketer/messages/"};
 try{
  const r=await fetch("https://api.onesignal.com/notifications",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Key "+key},body:JSON.stringify(payload)});
  const d=await r.json().catch(()=>({}));
  if(!r.ok){console.error("OneSignal notification failed",r.status,JSON.stringify(d).slice(0,1000));return {sent:0,warning:"push_provider_error"}}
  return {sent:Number(d.recipients||0),warning:null};
 }catch(e){console.error("OneSignal request failed",e);return {sent:0,warning:"push_provider_error"}}
}
export default async function(req,res){
 if(!(await requireAdminSession(req,res)))return;
 try{
  if(req.method==="GET"){
   const q=clean(req.query?.q),params=q?["%"+q+"%"]:[];
   const rows=await db.query(`SELECT id,referral_code,display_name,first_name,second_name,third_name,fourth_name,email,phone FROM app_profiles WHERE role='marketer' AND deleted_at IS NULL AND COALESCE(login_blocked,false)=false AND lower(COALESCE(status,'')) NOT IN ('blocked','deleted') ${q?"AND (id ILIKE $1 OR referral_code ILIKE $1 OR display_name ILIKE $1 OR concat_ws(' ',first_name,second_name,third_name,fourth_name) ILIKE $1)":""} ORDER BY created_at DESC LIMIT 300`,params);
   const recent=await db.query("WITH recent_batches AS (SELECT batch_id,MAX(created_at) AS sent_at FROM member_messages GROUP BY batch_id ORDER BY MAX(created_at) DESC LIMIT 30) SELECT m.id,m.batch_id,m.subject,m.message,m.created_at,m.recipient_id,m.media_key,m.media_type,m.show_in_site,m.send_push,m.viewed_at,m.read_at,p.display_name,p.first_name,p.second_name,p.third_name,p.fourth_name,p.referral_code FROM member_messages m JOIN recent_batches rb ON rb.batch_id=m.batch_id JOIN app_profiles p ON p.id=m.recipient_id ORDER BY rb.sent_at DESC,m.created_at ASC");
   return res.json({ok:true,marketers:rows.rows.map(x=>({...x,display_name:x.display_name||[x.first_name,x.second_name,x.third_name,x.fourth_name].filter(Boolean).join(" ")})),recent:await signedMedia(recent.rows)});
  }
  const b=body(req),subject=clean(b.subject).slice(0,180),message=clean(b.message).slice(0,10000),mode=clean(b.mode);
  const mediaKey=clean(b.media_key),mediaType=clean(b.media_type),showInSite=b.show_in_site!==false,sendPush=b.send_push===true;
  if(!message&&!mediaKey)return res.status(400).json({error:"message_or_media_required"});
  if(!showInSite&&!sendPush)return res.status(400).json({error:"choose_delivery_channel"});
  if(mediaKey&&(!mediaKey.startsWith("member-messages/")||!["image/jpeg","image/png","image/webp","image/gif","video/mp4","video/webm","video/quicktime"].includes(mediaType)))return res.status(400).json({error:"invalid_media"});
  let ids=[];
  if(mode==="all"){
   const all=await db.query("SELECT id FROM app_profiles WHERE role='marketer' AND deleted_at IS NULL AND COALESCE(login_blocked,false)=false AND lower(COALESCE(status,'')) NOT IN ('blocked','deleted')");
   ids=all.rows.map(x=>String(x.id));
  }else if(mode==="selected"||mode==="private"){
   const requested=Array.isArray(b.recipient_ids)?b.recipient_ids.map(clean).filter(Boolean):[clean(b.recipient_id)].filter(Boolean);
   if(!requested.length)return res.status(400).json({error:"recipient_required"});
   const found=await db.query("SELECT id FROM app_profiles WHERE role='marketer' AND deleted_at IS NULL AND COALESCE(login_blocked,false)=false AND lower(COALESCE(status,'')) NOT IN ('blocked','deleted') AND (id=ANY($1::text[]) OR referral_code=ANY($1::text[]))",[requested]);
   ids=[...new Set(found.rows.map(x=>String(x.id)))];
   if(!ids.length)return res.status(404).json({error:"marketer_not_found"});
  }else return res.status(400).json({error:"invalid_mode"});
  const created=await db.query("WITH batch AS (SELECT gen_random_uuid() AS id) INSERT INTO member_messages(batch_id,recipient_id,sender_id,subject,message,media_key,media_type,show_in_site,send_push) SELECT batch.id,recipients.recipient_id,NULL,$2,$3,$4,$5,$6,$7 FROM unnest($1::text[]) AS recipients(recipient_id) CROSS JOIN batch RETURNING id,batch_id",[ids,subject,message,mediaKey||null,mediaType||null,showInSite,sendPush]);
  let push={sent:0,warning:null};
  if(sendPush)push=await sendPushToRecipients(ids,subject,message);
  return res.json({ok:true,sent:created.rows.length,mode,push_sent:push.sent,push_warning:push.warning});
 }catch(e){console.error("admin messages failed",e);return res.status(500).json({error:"messages_operation_failed"});}
}