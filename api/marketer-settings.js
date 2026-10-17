import { db } from "hatchable";
import { requireNetworkUser, digest } from "../lib/network-auth.js";
export const access = "public";
export const methods = ["GET","POST"];
const hex = v => /^#[0-9a-f]{6}$/i.test(String(v||""));
export default async function(req,res){
  const user=await requireNetworkUser(req,res); if(!user)return;
  const uid=String(user.id);
  if(req.method==="GET"){
    const q=await db.query("SELECT theme_mode,theme_primary_color,theme_button_color,theme_text_color,theme_bg_color,login_password_hash,wallet_password_hash FROM app_profiles WHERE id=$1 AND role='marketer' LIMIT 1",[uid]);
    if(!q.rows.length)return res.status(404).json({error:"profile_not_found"});
    const x=q.rows[0]; return res.json({settings:{theme_mode:x.theme_mode||"dark",theme_primary_color:x.theme_primary_color||"#42d6a4",theme_button_color:x.theme_button_color||"#1683ff",theme_text_color:x.theme_text_color||"#f5f7fb",theme_bg_color:x.theme_bg_color||"#071426",login_password_set:!!x.login_password_hash,wallet_password_set:!!x.wallet_password_hash}});
  }
  const b=typeof req.body==="string"?JSON.parse(req.body||"{}"):(req.body||{}), action=String(b.action||"");
  if(action==="reset_theme"){
    const q=await db.query("UPDATE app_profiles SET theme_mode=$2,theme_primary_color=$3,theme_button_color=$4,theme_text_color=$5,theme_bg_color=$6 WHERE id=$1 AND role='marketer' RETURNING id",[uid,"dark","#42d6a4","#5ca8ff","#f5f7fb","#07111f"]);
    if(!q.rows.length)return res.status(404).json({error:"profile_not_found"});
    return res.json({ok:true,settings:{theme_mode:"dark",theme_primary_color:"#42d6a4",theme_button_color:"#5ca8ff",theme_text_color:"#f5f7fb",theme_bg_color:"#07111f"}});
  }
  if(action==="theme"){
    const mode=b.theme_mode==="light"?"light":"dark";
    const primary=hex(b.theme_primary_color)?b.theme_primary_color:"#42d6a4";
    const button=hex(b.theme_button_color)?b.theme_button_color:"#1683ff";
    const textColor=hex(b.theme_text_color)?b.theme_text_color:"#f5f7fb";
    const bg=hex(b.theme_bg_color)?b.theme_bg_color:"#071426";
    const q=await db.query("UPDATE app_profiles SET theme_mode=$2,theme_primary_color=$3,theme_button_color=$4,theme_text_color=$5,theme_bg_color=$6 WHERE id=$1 AND role='marketer' RETURNING id",[uid,mode,primary,button,textColor,bg]);
    if(!q.rows.length)return res.status(404).json({error:"profile_not_found"});
    return res.json({ok:true,settings:{theme_mode:mode,theme_primary_color:primary,theme_button_color:button,theme_text_color:textColor,theme_bg_color:bg}});
  }
  if(action==="login_password"||action==="wallet_password"){
    const current=String(b.current_password||""), next=String(b.new_password||"");
    if(next.length<8||next.length>200)return res.status(400).json({error:"password_too_short",min_length:8});
    const q=await db.query("SELECT login_password_hash,wallet_password_hash FROM app_profiles WHERE id=$1 AND role='marketer' LIMIT 1",[uid]);
    if(!q.rows.length)return res.status(404).json({error:"profile_not_found"});
    const profile=q.rows[0];
    const apps=await db.query("SELECT password_hash,wallet_password_hash FROM network_agent_applications WHERE member_id=$1 ORDER BY created_at DESC LIMIT 1",[uid]).catch(()=>({rows:[]}));
    const app=apps.rows[0]||{};
    const saved=action==="login_password"?(profile.login_password_hash||app.password_hash):(profile.wallet_password_hash||app.wallet_password_hash);
    if(saved && digest(current)!==String(saved))return res.status(400).json({error:"current_password_incorrect"});
    if(!saved && action==="wallet_password"){
      const loginSaved=profile.login_password_hash||app.password_hash;
      if(!loginSaved||digest(current)!==String(loginSaved))return res.status(400).json({error:"current_password_incorrect"});
    }
    const hash=digest(next);
    if(action==="login_password"){
      await db.query("UPDATE app_profiles SET login_password_hash=$2 WHERE id=$1",[uid,hash]);
      await db.query("UPDATE network_agent_applications SET password_hash=$2 WHERE member_id=$1",[uid,hash]).catch(()=>{});
    }else{
      await db.query("UPDATE app_profiles SET wallet_password_hash=$2 WHERE id=$1",[uid,hash]);
      await db.query("UPDATE network_agent_applications SET wallet_password_hash=$2 WHERE member_id=$1",[uid,hash]).catch(()=>{});
    }
    return res.json({ok:true});
  }
  return res.status(400).json({error:"invalid_action"});
}