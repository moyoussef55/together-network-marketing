export const access = "public";
import { db } from "hatchable";
import { requireNetworkUser } from "../lib/network-auth.js";
export default async function(req,res){
  const user=await requireNetworkUser(req,res);
  if(!user)return;
  const uid=user.id;
  if(req.method==="GET"){
    const r=await db.query("SELECT id,display_name,referral_code,email,phone,state,city,address,heir_name,heir_mother_name,avatar_url,cover_url FROM app_profiles WHERE id=$1 AND role='marketer' LIMIT 1",[uid]);
    if(!r.rows.length)return res.status(404).json({error:"profile_not_found"});
    return res.json({profile:r.rows[0]});
  }
  if(req.method!=="POST"&&req.method!=="PUT")return res.status(405).json({error:"method_not_allowed"});
  const b=typeof req.body==="string"?JSON.parse(req.body||"{}"):(req.body||{});
  const avatar=typeof b.avatar_url==="string"?b.avatar_url.trim():"";
  const cover=typeof b.cover_url==="string"?b.cover_url.trim():"";
  for(const [name,val,max] of [["avatar_url",avatar,1600000],["cover_url",cover,1600000]]){
    if(val && !/^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(val))return res.status(400).json({error:"invalid_"+name});
    if(val.length>max)return res.status(413).json({error:name+"_too_large"});
  }
  const fields={email:250,phone:30,state:100,city:100,address:500,heir_name:180,heir_mother_name:180};
  const v={};
  for(const [key,max] of Object.entries(fields)){const x=String(b[key]??"").trim();if(x.length>max)return res.status(400).json({error:"invalid_"+key});v[key]=x||null;}
  if(!v.email||!/^\S+@\S+\.\S+$/.test(v.email))return res.status(400).json({error:"valid_email_required"});
  const dupe=await db.query("SELECT id FROM app_profiles WHERE lower(email)=lower($1) AND id<>$2 LIMIT 1",[v.email,uid]);
  if(dupe.rows.length)return res.status(409).json({error:"email_already_used"});
  const r=await db.query("UPDATE app_profiles SET email=$2,phone=$3,state=$4,city=$5,address=$6,heir_name=$7,heir_mother_name=$8,avatar_url=$9,cover_url=$10 WHERE id=$1 AND role='marketer' RETURNING id,display_name,referral_code,email,phone,state,city,address,heir_name,heir_mother_name,avatar_url,cover_url",[uid,v.email,v.phone,v.state,v.city,v.address,v.heir_name,v.heir_mother_name,avatar||null,cover||null]);
  if(!r.rows.length)return res.status(404).json({error:"profile_not_found"});
  await db.query("UPDATE network_agent_applications SET email=$2,phone=$3,state=$4,city=$5,heir_name=$6,heir_mother_name=$7 WHERE member_id=$1",[uid,v.email,v.phone,v.state,v.city,v.heir_name,v.heir_mother_name]).catch(()=>{});
  return res.json({ok:true,profile:r.rows[0]});
}