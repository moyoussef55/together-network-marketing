import { db } from "hatchable";
import crypto from "node:crypto";
import { createNetworkSession, clearNetworkSession, getNetworkUser, digest } from "../lib/network-auth.js";

export const access = "public";
export const methods = ["GET","POST","DELETE"];

function sameHash(a,b) {
  const x = Buffer.from(String(a || ""), "hex");
  const y = Buffer.from(String(b || ""), "hex");
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x,y);
}

export default async function(req,res) {
  if (req.method === "DELETE") {
    await clearNetworkSession(req,res);
    return res.json({ ok:true });
  }

  if (req.method === "GET") {
    // Preserve the existing OTP/passkey path for users who still choose it.
    if (req.user?.id) {
      const p = await db.query("SELECT login_blocked,deleted_at,login_password_hash,wallet_password_hash,status FROM app_profiles WHERE id=$1 LIMIT 1",[String(req.user.id)]);
      if (p.rows.length) {
        if (p.rows[0].deleted_at) return res.status(403).json({error:"account_deleted"});
        if (p.rows[0].login_blocked || p.rows[0].status==="blocked") return res.status(403).json({error:"login_blocked"});
        return res.json({ok:true,password_required:true,password_set:!!p.rows[0].login_password_hash,wallet_password_set:!!p.rows[0].wallet_password_hash});
      }
    }
    const user = await getNetworkUser(req);
    if (!user) return res.json({ok:true,authenticated:false,user:null});
    return res.json({ok:true,authenticated:true,user:{id:user.id,email:user.email,name:user.name,role:user.role,referral_code:user.referral_code}});
  }

  const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const identifier = String(b.identifier || b.email || b.code || "").trim();
  const password = String(b.password || "");

  if (identifier) {
    if (!password) return res.status(400).json({error:"password_required"});
    const q = await db.query(
      `SELECT p.id,p.email,p.display_name,p.role,p.referral_code,p.status,p.deleted_at,p.login_blocked,p.login_password_hash,
              COALESCE(NULLIF(p.login_password_hash,''),NULLIF(a.password_hash,'')) AS effective_password_hash
         FROM app_profiles p
         LEFT JOIN LATERAL (
           SELECT na.password_hash
             FROM network_agent_applications na
            WHERE na.member_id=p.id
            ORDER BY na.joined_at DESC NULLS LAST,na.created_at DESC
            LIMIT 1
         ) a ON true
        WHERE (lower(COALESCE(p.email,''))=lower($1) OR upper(COALESCE(p.referral_code,''))=upper($1) OR upper(COALESCE(p.legacy_member_code,''))=upper($1))
          AND p.role='marketer'
        LIMIT 1`,
      [identifier]
    );
    const p = q.rows[0];
    if (!p) return res.status(401).json({error:"invalid_credentials"});
    if (p.deleted_at || p.status==="deleted") return res.status(403).json({error:"account_deleted"});
    if (p.login_blocked || p.status==="blocked") return res.status(403).json({error:"login_blocked"});
    if (!p.effective_password_hash) return res.status(403).json({error:"password_not_set"});
    const supplied = digest(password);
    if (!sameHash(supplied,p.effective_password_hash)) return res.status(401).json({error:"invalid_credentials"});
    if (!p.login_password_hash && p.effective_password_hash) {
      await db.query("UPDATE app_profiles SET login_password_hash=$2 WHERE id=$1 AND (login_password_hash IS NULL OR login_password_hash='')",[p.id,p.effective_password_hash]);
    }
    const token = await createNetworkSession(res,p.id,b.rememberMe === true);
    return res.json({ok:true,token,user:{id:p.id,email:p.email,name:p.display_name,role:p.role,referral_code:p.referral_code}});
  }

  // Backward compatibility for the former Hatchable OTP -> password setup/check flow.
  const uid = req.user?.id;
  if (!uid) return res.status(400).json({error:"identifier_required"});
  const p = await db.query("SELECT login_blocked,deleted_at,login_password_hash,status FROM app_profiles WHERE id=$1 LIMIT 1",[String(uid)]);
  if (!p.rows.length) return res.status(404).json({error:"profile_not_found"});
  if (p.rows[0].deleted_at) return res.status(403).json({error:"account_deleted"});
  if (p.rows[0].login_blocked || p.rows[0].status==="blocked") return res.status(403).json({error:"login_blocked"});
  if (!p.rows[0].login_password_hash) {
    if (password.length < 8) return res.status(400).json({error:"password_too_short",min_length:8});
    const hash = digest(password);
    await db.query("UPDATE app_profiles SET login_password_hash=$2 WHERE id=$1 AND login_password_hash IS NULL",[String(uid),hash]);
    await db.query("UPDATE network_agent_applications SET password_hash=$2 WHERE member_id=$1 AND (password_hash IS NULL OR password_hash='')",[String(uid),hash]).catch(()=>{});
    return res.json({ok:true,password_set:true});
  }
  if (!password) return res.status(400).json({error:"password_required"});
  if (!sameHash(digest(password),p.rows[0].login_password_hash)) return res.status(403).json({error:"invalid_login_password"});
  return res.json({ok:true});
}