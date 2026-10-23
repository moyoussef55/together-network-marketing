import { db, storage, config } from "hatchable";
import crypto from "node:crypto";
import { requireAdminSession } from "../../lib/admin-auth.js";
export const access="public";
export const methods=["GET","POST","DELETE"];
const types=new Map([["image/jpeg","jpg"],["image/png","png"],["image/webp","webp"],["image/gif","gif"],["video/mp4","mp4"],["video/webm","webm"],["video/quicktime","mov"]]);
function body(req){if(typeof req.body==="string"){try{return JSON.parse(req.body||"{}")}catch{return {}}}return req.body||{}}
async function saveMedia(b){if(!b.media_base64)return null;const mime=String(b.media_type||"").toLowerCase(),ext=types.get(mime);if(!ext)throw Object.assign(new Error("unsupported_media_type"),{status:415});const raw=String(b.media_base64).replace(/^data:[^,]+,/,"");if(!raw||raw.length>21_500_000)throw Object.assign(new Error("file_too_large"),{status:413});const bytes=Buffer.from(raw,"base64");if(!bytes.length||bytes.length>15_000_000)throw Object.assign(new Error("file_too_large"),{status:413});const key="recognitions/"+crypto.randomUUID()+"."+ext;await storage.put(key,bytes,mime);return {key,mime,name:String(b.media_name||("تكريم."+ext)).replace(/[\\/\r\n]/g,"_").slice(0,180),bytes:bytes.length}}
async function postShape(r){return {...r,media_url:r.media_key?await storage.url(r.media_key):null}}
const MARKETING_ONESIGNAL_APP_ID="437bb9c7-d30d-444a-9a93-0276e15967ff";
const MARKETING_SITE_ORIGIN="https://marketing.together-v-egp.com";
async function sendOneSignalRecognitionPush({appId,key,ids,title,message,url,label}){
 try{
  const payload={app_id:appId,target_channel:"push",include_aliases:{external_id:ids},headings:{en:title,ar:title},contents:{en:message,ar:message},url};
  const r=await fetch("https://api.onesignal.com/notifications",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Key "+key},body:JSON.stringify(payload)});
  const d=await r.json().catch(()=>({}));
  if(!r.ok){console.error("OneSignal "+label+" recognition push failed",r.status,JSON.stringify(d).slice(0,800));return {sent:0,warning:"push_provider_error"}}
  return {sent:Number(d.recipients||0),warning:null};
 }catch(e){console.error("OneSignal "+label+" recognition push request failed",String(e?.message||e));return {sent:0,warning:"push_provider_error"}}
}
async function sendRecognitionPush(ids,title,message,url){
 const unique=[...new Set((ids||[]).map(String).filter(Boolean))];if(!unique.length)return {sent:0,warning:null};
 const marketingKey=String(await config.get("ONESIGNAL_MARKETING_REST_API_KEY")||"").trim();
 if(!marketingKey)return {sent:0,warning:"marketing_push_not_configured"};
 const requestedPath=String(url||"/marketer/recognitions/").replace(/^https?:\/\/[^/]+/i,"");
 const path=requestedPath.startsWith("/")?requestedPath:"/marketer/recognitions/";
 return sendOneSignalRecognitionPush({
  appId:MARKETING_ONESIGNAL_APP_ID,key:marketingKey,ids:unique,title,message,
  url:MARKETING_SITE_ORIGIN+path,label:"marketing"
 });
}
function findMentioned(description,marketers){
 const text=String(description||"").toLocaleLowerCase("ar");const found=[];
 for(const m of marketers){const name=String(m.name||"").trim().toLocaleLowerCase("ar"),code=String(m.referral_code||"").trim().toLocaleLowerCase("ar");let hit=false;
  if(code){const at="@"+code;let i=text.indexOf(at);while(i>=0){const next=text[i+at.length]||"";if(!/[a-z0-9]/i.test(next)){hit=true;break}i=text.indexOf(at,i+1)}}
  if(!hit&&name.length>1&&text.includes("@"+name))hit=true;
  if(hit)found.push(m);
 }return found;
}
export default async function(req,res){
 if(!(await requireAdminSession(req,res)))return;
 if(req.method==="GET"){
  const posts=await db.query(`SELECT p.*, (SELECT count(*)::int FROM recognition_comments c WHERE c.post_id=p.id AND c.deleted_at IS NULL) comment_count,
   (SELECT count(*)::int FROM recognition_post_reactions x WHERE x.post_id=p.id AND x.reaction='like') likes,
   (SELECT count(*)::int FROM recognition_post_reactions x WHERE x.post_id=p.id AND x.reaction='love') loves
   FROM recognition_posts p ORDER BY p.created_at DESC,p.id DESC LIMIT 300`);
  const marketers=await db.query(`SELECT p.id,p.referral_code,p.login_blocked,p.status,COALESCE(NULLIF(p.display_name,''),concat_ws(' ',p.first_name,p.second_name,p.third_name,p.fourth_name),p.referral_code) name,
   COALESCE(c.can_post,false) can_post,COALESCE(c.comments_blocked,false) comments_blocked,COALESCE(c.posts_hidden,false) posts_hidden
   FROM app_profiles p LEFT JOIN recognition_marketer_controls c ON c.marketer_id=p.id WHERE p.role='marketer' AND p.deleted_at IS NULL ORDER BY name LIMIT 1000`);
  const comments=await db.query(`SELECT c.id,c.post_id,c.marketer_id,c.parent_comment_id,c.body,c.created_at,
   COALESCE(NULLIF(p.display_name,''),concat_ws(' ',p.first_name,p.second_name,p.third_name,p.fourth_name),p.referral_code,'مسوق') marketer_name
   FROM recognition_comments c LEFT JOIN app_profiles p ON p.id=c.marketer_id WHERE c.deleted_at IS NULL ORDER BY c.created_at DESC LIMIT 500`);
  const activity=await db.query(`SELECT * FROM (SELECT 'comment:'||c.id::text event_id,CASE WHEN c.parent_comment_id IS NULL THEN 'comment' ELSE 'reply' END event_type,COALESCE(NULLIF(a.display_name,''),concat_ws(' ',a.first_name,a.second_name,a.third_name,a.fourth_name),a.referral_code,'مسوق') actor_name,c.post_id,c.id comment_id,c.body detail,p.description post_description,c.created_at FROM recognition_comments c LEFT JOIN app_profiles a ON a.id=c.marketer_id LEFT JOIN recognition_posts p ON p.id=c.post_id WHERE c.deleted_at IS NULL UNION ALL SELECT 'post-reaction:'||r.id::text event_id,CASE WHEN r.reaction='love' THEN 'post_love' ELSE 'post_like' END event_type,COALESCE(NULLIF(a.display_name,''),concat_ws(' ',a.first_name,a.second_name,a.third_name,a.fourth_name),a.referral_code,'مسوق') actor_name,r.post_id,NULL::uuid comment_id,NULL::text detail,p.description post_description,r.created_at FROM recognition_post_reactions r LEFT JOIN app_profiles a ON a.id=r.marketer_id LEFT JOIN recognition_posts p ON p.id=r.post_id UNION ALL SELECT 'comment-reaction:'||r.id::text event_id,CASE WHEN r.reaction='love' THEN 'comment_love' ELSE 'comment_like' END event_type,COALESCE(NULLIF(a.display_name,''),concat_ws(' ',a.first_name,a.second_name,a.third_name,a.fourth_name),a.referral_code,'مسوق') actor_name,c.post_id,r.comment_id,c.body detail,p.description post_description,r.created_at FROM recognition_comment_reactions r JOIN recognition_comments c ON c.id=r.comment_id LEFT JOIN app_profiles a ON a.id=r.marketer_id LEFT JOIN recognition_posts p ON p.id=c.post_id WHERE c.deleted_at IS NULL) feed ORDER BY created_at DESC,event_id DESC LIMIT 500`);
  return res.json({ok:true,posts:await Promise.all(posts.rows.map(postShape)),marketers:marketers.rows,comments:comments.rows,activity:activity.rows});
 }
 const b=body(req),action=String(b.action||"");
 try{
  if(action==="create_post"){
   const description=String(b.description||"").trim();if(!description||description.length>5000)return res.status(400).json({ok:false,error:"description_required"});
   const media=await saveMedia(b);
   try{
    const r=await db.query("INSERT INTO recognition_posts(description,media_key,media_type,media_name,media_bytes,author_admin) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",[description,media?.key||null,media?.mime||null,media?.name||null,media?.bytes||null,req.user?.id||"admin"]);
    let pushResult={sent:0,warning:null},mentionPush={sent:0,warning:null},mentioned=[];
    try{
     const eligible=await db.query(`SELECT p.id,p.referral_code,COALESCE(NULLIF(p.display_name,''),concat_ws(' ',p.first_name,p.second_name,p.third_name,p.fourth_name),p.referral_code) name
      FROM app_profiles p WHERE p.role='marketer' AND p.deleted_at IS NULL
       AND COALESCE(p.login_blocked,false)=false
       AND lower(COALESCE(p.status,'')) NOT IN ('blocked','deleted') ORDER BY p.id`);
     mentioned=findMentioned(description,eligible.rows);
     const mentionedIds=new Set(mentioned.map(x=>String(x.id)));
     await db.query(`INSERT INTO recognition_notifications(recipient_marketer_id,post_id,event_type,message)
      SELECT p.id,$1,'new_post','تم نشر تكريم جديد من إدارة توجيذر'
      FROM app_profiles p
      WHERE p.role='marketer' AND p.deleted_at IS NULL
       AND COALESCE(p.login_blocked,false)=false
       AND lower(COALESCE(p.status,'')) NOT IN ('blocked','deleted')`,[r.rows[0].id]);
     for(const m of mentioned){
      await db.query(`INSERT INTO recognition_notifications(recipient_marketer_id,post_id,event_type,message)
       VALUES($1,$2,'mention',$3)`,[m.id,r.rows[0].id,'تمت الإشارة إليك بالاسم أو الكود في منشور تكريم من الإدارة.']);
     }
     const everyone=eligible.rows.map(x=>String(x.id));
     const generalIds=everyone;
     pushResult=await sendRecognitionPush(generalIds,'تكريم جديد من Together','تم نشر منشور جديد في قسم التكريمات. اضغط لمشاهدته.','https://together-network.hatchable.site/marketer/recognitions/');
     if(mentioned.length){
      mentionPush=await sendRecognitionPush(mentioned.map(x=>x.id),'تمت الإشارة إليك في التكريمات','ذكرتك الإدارة في منشور تكريم. اضغط لعرض المنشور.','https://together-network.hatchable.site/marketer/recognitions/notifications/');
     }
    }catch(notifyError){console.error("recognition new-post notifications failed",notifyError);if(!pushResult.warning)pushResult.warning="notification_processing_error"}
    return res.status(201).json({ok:true,post:await postShape(r.rows[0]),mentioned_count:mentioned.length,push_sent:pushResult.sent+mentionPush.sent,push_warning:pushResult.warning||mentionPush.warning||null})
   }catch(e){if(media?.key)await storage.del(media.key);throw e}
  }
  if(action==="edit_post"){
   const id=String(b.post_id||"");const desc=String(b.description||"").trim();if(!id||!desc||desc.length>5000)return res.status(400).json({ok:false,error:"post_and_description_required"});
   const old=await db.query("SELECT * FROM recognition_posts WHERE id=$1",[id]);if(!old.rows.length)return res.status(404).json({ok:false,error:"post_not_found"});
   const media=await saveMedia(b);
   const r=media?await db.query("UPDATE recognition_posts SET description=$2,media_key=$3,media_type=$4,media_name=$5,media_bytes=$6,updated_at=now() WHERE id=$1 RETURNING *",[id,desc,media.key,media.mime,media.name,media.bytes]):await db.query("UPDATE recognition_posts SET description=$2,updated_at=now() WHERE id=$1 RETURNING *",[id,desc]);
   if(media&&old.rows[0].media_key)await storage.del(old.rows[0].media_key).catch(()=>{});
   return res.json({ok:true,post:await postShape(r.rows[0])});
  }
  if(action==="delete_post"){
   const id=String(b.post_id||"");const r=await db.query("DELETE FROM recognition_posts WHERE id=$1 RETURNING media_key",[id]);if(!r.rows.length)return res.status(404).json({ok:false,error:"post_not_found"});if(r.rows[0].media_key)await storage.del(r.rows[0].media_key).catch(()=>{});return res.json({ok:true});
  }
  if(action==="delete_comment"){
   const r=await db.query("DELETE FROM recognition_comments WHERE id=$1 RETURNING id",[String(b.comment_id||"")]);return res.json({ok:true,deleted:!!r.rows.length});
  }
  if(action==="block_marketer"){
   const id=String(b.marketer_id||"");if(!id)return res.status(400).json({ok:false,error:"marketer_required"});
   const r=await db.query("UPDATE app_profiles SET status='blocked',login_blocked=true WHERE id=$1 AND role='marketer' AND deleted_at IS NULL RETURNING id",[id]);
   if(!r.rows.length)return res.status(404).json({ok:false,error:"marketer_not_found"});
   return res.json({ok:true,marketer_id:id,status:"blocked",login_blocked:true});
  }
  if(action==="unblock_marketer"){
   const id=String(b.marketer_id||"");if(!id)return res.status(400).json({ok:false,error:"marketer_required"});
   const r=await db.query("UPDATE app_profiles SET status=CASE WHEN lower(COALESCE(status,''))='blocked' THEN 'active' ELSE status END,login_blocked=false WHERE id=$1 AND role='marketer' AND deleted_at IS NULL RETURNING id,status,login_blocked",[id]);
   if(!r.rows.length)return res.status(404).json({ok:false,error:"marketer_not_found"});
   return res.json({ok:true,marketer_id:id,status:r.rows[0].status,login_blocked:false});
  }
  if(action==="control_marketer"){
   const id=String(b.marketer_id||"");if(!id)return res.status(400).json({ok:false,error:"marketer_required"});
   const exists=await db.query("SELECT id FROM app_profiles WHERE id=$1 AND role='marketer' AND deleted_at IS NULL",[id]);if(!exists.rows.length)return res.status(404).json({ok:false,error:"marketer_not_found"});
   const allowed=["can_post","comments_blocked","posts_hidden"];if(!allowed.includes(b.field))return res.status(400).json({ok:false,error:"invalid_control"});
   const val=!!b.value;await db.query(`INSERT INTO recognition_marketer_controls(marketer_id,${b.field},updated_at) VALUES($1,$2,now()) ON CONFLICT(marketer_id) DO UPDATE SET ${b.field}=EXCLUDED.${b.field},updated_at=now()`,[id,val]);
   return res.json({ok:true,marketer_id:id,field:b.field,value:val});
  }
  return res.status(400).json({ok:false,error:"unknown_action"});
 }catch(e){console.error("admin recognitions error",e);return res.status(e.status||500).json({ok:false,error:e.status?e.message:"recognition_operation_failed"});}
}