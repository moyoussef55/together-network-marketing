import { db } from "hatchable";
import { sendAgentWelcomeEmail } from "../../lib/agent-welcome-email.js";
import { getNetworkUser } from "../../lib/network-auth.js";
export const access = "public";
export const methods = ["POST"];

export default async function(req,res){
  const user=await getNetworkUser(req);
  const uid=user?.id||req.user?.id;
  if(!uid)return res.status(401).json({error:"login_required"});
  const b=typeof req.body==="string"?JSON.parse(req.body||"{}"):(req.body||{});
  const adminMode=req.user?.role==='admin' || req.user?.is_admin===true;
  const id=String(b.application_id||"").trim(), code=String(b.ibn_code||"").trim();
  if(!id||!code)return res.status(400).json({error:"missing_confirmation_data"});
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
    return res.status(400).json({error:"invalid_application_id"});

  let app;
  if(adminMode){
    app=await db.query("SELECT * FROM network_agent_applications WHERE id=$1 AND status='pending_ibn' LIMIT 1",[id]);
  }else{
    app=await db.query(`WITH RECURSIVE network AS (
      SELECT p.member_id::text FROM network_placements p WHERE p.owner_marketer_id=$1
      UNION
      SELECT p2.member_id::text FROM network_placements p2 JOIN network n ON n.member_id=p2.owner_marketer_id
    ) SELECT a.* FROM network_agent_applications a
      WHERE a.id=$2 AND a.status='pending_ibn'
        AND (a.owner_marketer_id=$1 OR a.owner_marketer_id::text IN (SELECT member_id FROM network))
      LIMIT 1`,[uid,id]);
  }
  if(!app.rows.length)return res.status(404).json({error:"application_not_found"});
  const ibn=await db.query("SELECT * FROM network_ibns WHERE code=$1 AND active=true AND used_count<quantity AND expires_at>now() LIMIT 1",[code]);
  if(!ibn.rows.length)return res.status(400).json({error:"invalid_or_expired_ibn"});
  if(b.action==="preview")return res.json({ok:true,ibn_amount:ibn.rows[0].amount});
  const x=app.rows[0], n=ibn.rows[0], ownerId=x.owner_marketer_id;

  const memberId=crypto.randomUUID();
  const referral=await db.query("SELECT id FROM app_profiles WHERE id=$1 OR referral_code=$1 LIMIT 1",[x.referral_id]);
  if(!referral.rows.length)return res.status(404).json({error:"referral_not_found"});

  const referralId=referral.rows[0].id;
  const fullName=[x.first_name,x.second_name,x.third_name,x.fourth_name].filter(Boolean).join(" ");
  const referralCode="TO"+memberId.replaceAll("-","").slice(0,5).toLowerCase();

  await db.query("INSERT INTO app_profiles(id,role,referral_code,sponsor_id,display_name,phone,status,first_name,second_name,third_name,fourth_name,national_id,email,country,state,city,heir_name,heir_mother_name,login_password_hash,wallet_password_hash) VALUES($1,'marketer',$2,$3,$4,$5,'active',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)",[memberId,referralCode,referralId,fullName,x.phone,x.first_name,x.second_name,x.third_name,x.fourth_name,x.national_id,x.email,x.country,x.state,x.city,x.heir_name,x.heir_mother_name,x.password_hash,x.wallet_password_hash]);
  // New confirmed agents enter active status now; this timestamp gates future BV.
  await db.query("UPDATE app_profiles SET activation_started_at=COALESCE(activation_started_at,now()) WHERE id=$1 AND status='active'",[memberId]);
  const joinedResult=await db.query("UPDATE network_agent_applications SET status='joined',ibn_code=$1,ibn_amount=$2,ibn_expires_at=$3,joined_at=now(),member_id=$4 WHERE id=$5 RETURNING joined_at",[code,n.amount,n.expires_at,memberId,id]);
  await db.query("UPDATE network_ibns SET used_count=used_count+1,active=false,used_by_upline_id=$1,registered_agent_id=$2,used_at=now() WHERE id=$3",[ownerId,memberId,n.id]);

  const side=x.slot_no===1?"left":"right";
  await db.query("INSERT INTO network_placements(owner_marketer_id,account_position,side,member_id,parent_member_id) VALUES($1,$2,$3,$4,$1)",[ownerId,x.account_position,side,memberId]);

  // Registration alone never earns a direct commission. A qualifying paid purchase
  // creates a yellow pending commission; the weekly Saturday 00:00 Cairo update releases it.
  await db.query("INSERT INTO network_notifications(recipient_id,type,title,body,entity_id) SELECT id,'new_agent','انضم وكيل جديد','تم انضمام وكيل جديد إلى شبكتك. رحّب به.', $1 FROM app_profiles WHERE id=$2 OR sponsor_id=$2",[memberId,ownerId]);

  const welcomeEmail=await sendAgentWelcomeEmail({application:x,memberId,referralCode,joinedAt:joinedResult.rows[0]?.joined_at,accountPosition:x.account_position,slotNo:x.slot_no,ibnAmount:n.amount});
  return res.json({ok:true,member_id:memberId,full_name:fullName,referral_code:referralCode,joined_at:joinedResult.rows[0]?.joined_at||new Date().toISOString(),ibn_amount:n.amount,welcome_email_sent:welcomeEmail.sent,welcome_email_error:welcomeEmail.sent?null:welcomeEmail.error});
}