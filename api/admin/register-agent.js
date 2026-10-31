import { db } from "hatchable";
import { requireAdminSession } from "../../lib/admin-auth.js";
import { hashNetworkPassword } from "../../lib/network-auth.js";
export const access = "public";
export const methods=["POST"];
async function digest(v){return hashNetworkPassword(v)}
export default async function(req,res){if(!(await requireAdminSession(req,res)))return;
 const b=typeof req.body==="string"?JSON.parse(req.body||"{}"):(req.body||{}),owner=String(b.owner_id||"").trim(),pos=Number(b.account_position),slot=Number(b.slot_no);
 if(!owner||![2,3].includes(pos)||![1,2].includes(slot))return res.status(400).json({error:"invalid_target"});
 const required=["first_name","second_name","national_id","phone","email","country","password","password_confirm","wallet_password","wallet_password_confirm"];
 if(required.some(k=>!String(b[k]||"").trim()))return res.status(400).json({error:"missing_fields"});
 const registrationMode=String(b.registration_mode||"offline");
 if(!["offline","online"].includes(registrationMode))return res.status(400).json({error:"invalid_registration_mode"});
 const mediaKeys=["national_id_front_key","national_id_back_key","declaration_image_key"];
 if(registrationMode==="offline")mediaKeys.push("voice_recording_key","paper_contract_key");
 if(mediaKeys.some(k=>!String(b[k]||"").startsWith("registration-media/")))return res.status(400).json({error:"registration_media_required"});
 if(b.password!==b.password_confirm)return res.status(400).json({error:"password_mismatch"});
 if(b.wallet_password!==b.wallet_password_confirm)return res.status(400).json({error:"wallet_password_mismatch"});
 const own=await db.query("SELECT id,role FROM app_profiles WHERE id=$1 AND deleted_at IS NULL LIMIT 1",[owner]);
 if(!own.rows.length)return res.status(404).json({error:"owner_not_found"});
 const taken=await db.query("SELECT id FROM network_agent_applications WHERE owner_marketer_id=$1 AND account_position=$2 AND slot_no=$3 AND status IN ('pending_ibn','confirmed','joined') LIMIT 1",[owner,pos,slot]);
 if(taken.rows.length)return res.status(409).json({error:"slot_taken"});
 const requested=String(b.referral_override||b.referral_id||owner).trim();
 const ref=await db.query("SELECT id FROM app_profiles WHERE id=$1 OR referral_code=$1 LIMIT 1",[requested]);
 if(!ref.rows.length)return res.status(404).json({error:"referral_not_found"});
 const ph=await digest(b.password),wh=await digest(b.wallet_password);
 const ins=await db.query(`INSERT INTO network_agent_applications(owner_marketer_id,account_position,slot_no,first_name,second_name,third_name,fourth_name,national_id,phone,email,country,state,city,heir_name,heir_mother_name,referral_id,password_hash,wallet_password_hash,terms_accepted,registration_mode,national_id_front_key,national_id_back_key,voice_recording_key,paper_contract_key,declaration_image_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) RETURNING id`,[owner,pos,slot,b.first_name,b.second_name,b.third_name||null,b.fourth_name||null,b.national_id,b.phone,b.email,b.country,b.state||null,b.city||null,b.heir_name||null,b.heir_mother_name||null,ref.rows[0].id,ph,wh,true,registrationMode,b.national_id_front_key,b.national_id_back_key,b.voice_recording_key||null,b.paper_contract_key||null,b.declaration_image_key]);
 return res.json({ok:true,application_id:ins.rows[0].id});
}