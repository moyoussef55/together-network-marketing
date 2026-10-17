import { db, storage } from "hatchable";
import crypto from "node:crypto";
import { requireNetworkUser } from "../../lib/network-auth.js";
export const access="public";
export const methods=["GET","POST"];
const types=new Map([["image/jpeg","jpg"],["image/png","png"],["image/webp","webp"],["image/gif","gif"],["video/mp4","mp4"],["video/webm","webm"],["video/quicktime","mov"]]);
function body(req){if(typeof req.body==="string"){try{return JSON.parse(req.body||"{}")}catch{return {}}}return req.body||{}}
async function saveMedia(b,userId){if(!b.media_base64)return null;const mime=String(b.media_type||"").toLowerCase(),ext=types.get(mime);if(!ext)throw Object.assign(new Error("unsupported_media_type"),{status:415});const raw=String(b.media_base64).replace(/^data:[^,]+,/,"");if(!raw||raw.length>21_500_000)throw Object.assign(new Error("file_too_large"),{status:413});const bytes=Buffer.from(raw,"base64");if(!bytes.length||bytes.length>15_000_000)throw Object.assign(new Error("file_too_large"),{status:413});const key="recognitions/member-"+userId+"/"+crypto.randomUUID()+"."+ext;await storage.put(key,bytes,mime);return {key,mime,name:String(b.media_name||("تكريم."+ext)).replace(/[\\/\r\n]/g,"_").slice(0,180),bytes:bytes.length}}
async function profile(userId){const r=await db.query("SELECT role,deleted_at,login_blocked,status FROM app_profiles WHERE id=$1 LIMIT 1",[userId]);const p=r.rows[0];if(!p||p.role!=="marketer"||p.deleted_at||p.login_blocked||["blocked","deleted"].includes(String(p.status||"").toLowerCase()))return false;return true}
export default async function(req,res){
 const user=await requireNetworkUser(req,res);if(!user)return;if(!(await profile(user.id)))return res.status(403).json({ok:false,error:"account_unavailable"});
 const ctl=await db.query("SELECT can_post,comments_blocked,posts_hidden FROM recognition_marketer_controls WHERE marketer_id=$1",[user.id]);const control=ctl.rows[0]||{can_post:false,comments_blocked:false,posts_hidden:false};
 if(req.method==="GET"){
  if(String(req.query?.view||"")==="notifications"){
   const r=await db.query("SELECT id,event_type,message,post_id,comment_id,actor_marketer_id,created_at,read_at FROM recognition_notifications WHERE recipient_marketer_id=$1 ORDER BY created_at DESC,id DESC LIMIT 150",[user.id]);
   await db.query("UPDATE recognition_notifications SET read_at=now() WHERE recipient_marketer_id=$1 AND read_at IS NULL",[user.id]);
   return res.json({ok:true,notifications:r.rows,unread:r.rows.filter(x=>!x.read_at).length});
  }
  if(control.posts_hidden)return res.json({ok:true,posts:[],can_post:!!control.can_post,comments_blocked:!!control.comments_blocked,posts_hidden:true});
  const posts=await db.query(`SELECT p.id,p.description,p.media_key,p.media_type,p.media_name,p.created_at,p.updated_at,
   (SELECT count(*)::int FROM recognition_comments c WHERE c.post_id=p.id AND c.deleted_at IS NULL) comment_count,
   (SELECT count(*)::int FROM recognition_post_reactions x WHERE x.post_id=p.id AND x.reaction='like') likes,
   (SELECT count(*)::int FROM recognition_post_reactions x WHERE x.post_id=p.id AND x.reaction='love') loves,
   (SELECT reaction FROM recognition_post_reactions x WHERE x.post_id=p.id AND x.marketer_id=$1) my_reaction
   FROM recognition_posts p ORDER BY p.created_at DESC,p.id DESC LIMIT 300`,[user.id]);
  const comments=await db.query(`SELECT c.id,c.post_id,c.marketer_id,c.parent_comment_id,c.body,c.created_at,
   COALESCE(NULLIF(p.display_name,''),concat_ws(' ',p.first_name,p.second_name,p.third_name,p.fourth_name),p.referral_code,'مسوق') marketer_name,
   (SELECT count(*)::int FROM recognition_comment_reactions x WHERE x.comment_id=c.id AND x.reaction='like') likes,
   (SELECT count(*)::int FROM recognition_comment_reactions x WHERE x.comment_id=c.id AND x.reaction='love') loves,
   (SELECT reaction FROM recognition_comment_reactions x WHERE x.comment_id=c.id AND x.marketer_id=$1) my_reaction
   FROM recognition_comments c LEFT JOIN app_profiles p ON p.id=c.marketer_id
   WHERE c.deleted_at IS NULL AND c.post_id=ANY($2::uuid[]) ORDER BY c.created_at ASC,c.id ASC`,[user.id,posts.rows.map(x=>x.id)]);
  const full=await Promise.all(posts.rows.map(async p=>({...p,media_url:p.media_key?await storage.url(p.media_key):null})));
  const unread=await db.query("SELECT count(*)::int n FROM recognition_notifications WHERE recipient_marketer_id=$1 AND read_at IS NULL",[user.id]);
  return res.json({ok:true,posts:full,comments:comments.rows,can_post:!!control.can_post,comments_blocked:!!control.comments_blocked,unread_notifications:unread.rows[0]?.n||0});
 }
 const b=body(req),action=String(b.action||"");
 try{
  if(action==="create_post"){
   if(!control.can_post)return res.status(403).json({ok:false,error:"posting_not_allowed"});
   if(control.posts_hidden)return res.status(403).json({ok:false,error:"recognitions_hidden"});
   const desc=String(b.description||"").trim();if(!desc||desc.length>5000)return res.status(400).json({ok:false,error:"description_required"});
   const media=await saveMedia(b,user.id);
   try{const r=await db.query("INSERT INTO recognition_posts(description,media_key,media_type,media_name,media_bytes,author_admin) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",[desc,media?.key||null,media?.mime||null,media?.name||null,media?.bytes||null,"marketer:"+user.id]);return res.status(201).json({ok:true,post:{...r.rows[0],media_url:media?.key?await storage.url(media.key):null}})}catch(e){if(media?.key)await storage.del(media.key);throw e}
  }
  if(action==="comment"){
   if(control.comments_blocked)return res.status(403).json({ok:false,error:"comments_blocked"});
   const postId=String(b.post_id||""),parent=b.parent_comment_id?String(b.parent_comment_id):null,comment=String(b.body||"").trim();
   if(!postId||!comment||comment.length>2000)return res.status(400).json({ok:false,error:"comment_required"});
   const post=await db.query("SELECT id FROM recognition_posts WHERE id=$1",[postId]);if(!post.rows.length)return res.status(404).json({ok:false,error:"post_not_found"});
   if(parent){const pr=await db.query("SELECT id,post_id,marketer_id,deleted_at FROM recognition_comments WHERE id=$1",[parent]);if(!pr.rows.length||pr.rows[0].post_id!==postId||pr.rows[0].deleted_at)return res.status(400).json({ok:false,error:"parent_comment_not_found"});}
   const saved=await db.query("INSERT INTO recognition_comments(post_id,marketer_id,parent_comment_id,body) VALUES($1,$2,$3,$4) RETURNING *",[postId,user.id,parent,comment]);
   const name=String(user.name||user.referral_code||"مسوق");
   if(parent){const pr=await db.query("SELECT marketer_id FROM recognition_comments WHERE id=$1",[parent]);const recipient=pr.rows[0]?.marketer_id;if(recipient&&recipient!==user.id)await db.query("INSERT INTO recognition_notifications(recipient_marketer_id,actor_marketer_id,post_id,comment_id,event_type,message) VALUES($1,$2,$3,$4,'reply','رد '+$5+' على تعليقك')",[recipient,user.id,postId,saved.rows[0].id,name]);}
   else{
    const prior=await db.query("SELECT DISTINCT marketer_id FROM recognition_comments WHERE post_id=$1 AND id<>$2 AND deleted_at IS NULL",[postId,saved.rows[0].id]);
    for(const x of prior.rows)if(x.marketer_id!==user.id)await db.query("INSERT INTO recognition_notifications(recipient_marketer_id,actor_marketer_id,post_id,comment_id,event_type,message) VALUES($1,$2,$3,$4,'comment','أضاف '+$5+' تعليقًا على تكريم تتابعه')",[x.marketer_id,user.id,postId,saved.rows[0].id,name]);
   }
   return res.status(201).json({ok:true,comment:{...saved.rows[0],marketer_name:name,likes:0,loves:0,my_reaction:null}});
  }
  if(action==="react_post"){
   const postId=String(b.post_id||""),reaction=String(b.reaction||"");if(!["like","love"].includes(reaction))return res.status(400).json({ok:false,error:"invalid_reaction"});
   const old=await db.query("SELECT reaction FROM recognition_post_reactions WHERE post_id=$1 AND marketer_id=$2",[postId,user.id]);
   if(old.rows[0]?.reaction===reaction)await db.query("DELETE FROM recognition_post_reactions WHERE post_id=$1 AND marketer_id=$2",[postId,user.id]);
   else await db.query("INSERT INTO recognition_post_reactions(post_id,marketer_id,reaction) VALUES($1,$2,$3) ON CONFLICT(post_id,marketer_id) DO UPDATE SET reaction=EXCLUDED.reaction,created_at=now()",[postId,user.id,reaction]);
   return res.json({ok:true,reaction:old.rows[0]?.reaction===reaction?null:reaction});
  }
  if(action==="react_comment"){
   const commentId=String(b.comment_id||""),reaction=String(b.reaction||"");if(!["like","love"].includes(reaction))return res.status(400).json({ok:false,error:"invalid_reaction"});
   const c=await db.query("SELECT id,post_id,marketer_id FROM recognition_comments WHERE id=$1 AND deleted_at IS NULL",[commentId]);if(!c.rows.length)return res.status(404).json({ok:false,error:"comment_not_found"});
   const old=await db.query("SELECT reaction FROM recognition_comment_reactions WHERE comment_id=$1 AND marketer_id=$2",[commentId,user.id]);
   if(old.rows[0]?.reaction===reaction)await db.query("DELETE FROM recognition_comment_reactions WHERE comment_id=$1 AND marketer_id=$2",[commentId,user.id]);
   else{
    await db.query("INSERT INTO recognition_comment_reactions(comment_id,marketer_id,reaction) VALUES($1,$2,$3) ON CONFLICT(comment_id,marketer_id) DO UPDATE SET reaction=EXCLUDED.reaction,created_at=now()",[commentId,user.id,reaction]);
    if(c.rows[0].marketer_id!==user.id)await db.query("INSERT INTO recognition_notifications(recipient_marketer_id,actor_marketer_id,post_id,comment_id,event_type,message) VALUES($1,$2,$3,$4,$5,$6)",[c.rows[0].marketer_id,user.id,c.rows[0].post_id,commentId,reaction==="love"?"comment_love":"comment_like",(user.name||user.referral_code||"مسوق")+(reaction==="love"?" وضع قلبًا على تعليقك":" أعجب بتعليقك")]);
   }
   return res.json({ok:true,reaction:old.rows[0]?.reaction===reaction?null:reaction});
  }
  return res.status(400).json({ok:false,error:"unknown_action"});
 }catch(e){console.error("marketer recognitions error",e);return res.status(e.status||500).json({ok:false,error:e.status?e.message:"recognition_operation_failed"});}
}