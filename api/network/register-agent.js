import { db } from "hatchable";
import { requireNetworkUser } from "../../lib/network-auth.js";
export const access = "public";
export const methods = ["GET","POST"];

async function digest(value){
  const bytes=new TextEncoder().encode(String(value));
  const hash=await crypto.subtle.digest("SHA-256",bytes);
  return Array.from(new Uint8Array(hash)).map(x=>x.toString(16).padStart(2,"0")).join("");
}

export default async function(req,res){
  const user=await requireNetworkUser(req,res);
  if(!user)return;
  const uid=user.id;

  if(req.method==="GET"){
    const rows=await db.query(
      "SELECT account_position,slot_no,first_name,second_name,third_name,fourth_name,status,joined_at FROM network_agent_applications WHERE owner_marketer_id=$1 ORDER BY account_position,slot_no",
      [uid]
    );
    const profile=await db.query("SELECT id,referral_code,display_name FROM app_profiles WHERE id=$1 LIMIT 1",[uid]);
    return res.json({applications:rows.rows,referral:profile.rows[0]||{id:uid}});
  }

  const b=typeof req.body==="string"?JSON.parse(req.body||"{}"):(req.body||{});
  const pos=Number(b.account_position), slot=Number(b.slot_no);
  const requestedOwner=String(b.owner_id||"").trim();
  let placementOwner=uid;
  if(requestedOwner && requestedOwner!==uid){
    const allowed=await db.query(`WITH RECURSIVE network AS (
      SELECT p.member_id::text FROM network_placements p WHERE p.owner_marketer_id=$1
      UNION
      SELECT p2.member_id::text FROM network_placements p2 JOIN network n ON n.member_id=p2.owner_marketer_id
    ) SELECT 1 FROM network WHERE member_id=$2 LIMIT 1`,[uid,requestedOwner]);
    if(!allowed.rows.length) return res.status(403).json({error:"network_access_denied"});
    placementOwner=requestedOwner;
  }
  const required=["first_name","second_name","national_id","phone","email","country","password","password_confirm","wallet_password","wallet_password_confirm"];
  if(![2,3].includes(pos)||![1,2].includes(slot)||required.some(k=>!String(b[k]||"").trim()))
    return res.status(400).json({error:"missing_fields"});
  const registrationMode=String(b.registration_mode||"offline");
  if(!["offline","online"].includes(registrationMode))return res.status(400).json({error:"invalid_registration_mode"});
  const mediaKeys=["national_id_front_key","national_id_back_key","declaration_image_key"];
  if(registrationMode==="offline")mediaKeys.push("voice_recording_key","paper_contract_key");
  if(mediaKeys.some(k=>!String(b[k]||"").startsWith("registration-media/")))
    return res.status(400).json({error:"registration_media_required"});
  if(b.password!==b.password_confirm) return res.status(400).json({error:"password_mismatch"});
  if(b.wallet_password!==b.wallet_password_confirm) return res.status(400).json({error:"wallet_password_mismatch"});
  if(!b.terms_accepted) return res.status(400).json({error:"terms_required"});

  const taken=await db.query("SELECT id,status FROM network_agent_applications WHERE owner_marketer_id=$1 AND account_position=$2 AND slot_no=$3 AND status IN ('pending_ibn','confirmed','joined') LIMIT 1",[placementOwner,pos,slot]);
  if(taken.rows.length){
    if(taken.rows[0].status==="pending_ibn")
      return res.json({ok:true,resume:true,application_id:taken.rows[0].id});
    return res.status(409).json({error:"slot_taken"});
  }

  const requestedReferral=String(b.referral_override||"").trim();
  const ref=await db.query("SELECT id FROM app_profiles WHERE id=$1 OR referral_code=$1 LIMIT 1",[requestedReferral||placementOwner]);
  if(!ref.rows.length) return res.status(404).json({error:"referral_not_found"});
  const finalReferralId=ref.rows[0].id;

  const passwordHash=await digest(b.password);
  const walletHash=await digest(b.wallet_password);
  const ins=await db.query(
    `INSERT INTO network_agent_applications
    (owner_marketer_id,account_position,slot_no,first_name,second_name,third_name,fourth_name,national_id,phone,email,country,state,city,heir_name,heir_mother_name,referral_id,password_hash,wallet_password_hash,terms_accepted,registration_mode,national_id_front_key,national_id_back_key,voice_recording_key,paper_contract_key,declaration_image_key)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
    RETURNING id`,
    [placementOwner,pos,slot,b.first_name,b.second_name,b.third_name||null,b.fourth_name||null,b.national_id,b.phone,b.email,b.country,b.state||null,b.city||null,b.heir_name||null,b.heir_mother_name||null,finalReferralId,passwordHash,walletHash,true,registrationMode,b.national_id_front_key,b.national_id_back_key,b.voice_recording_key||null,b.paper_contract_key||null,b.declaration_image_key]
  );
  return res.json({ok:true,application_id:ins.rows[0].id});
}