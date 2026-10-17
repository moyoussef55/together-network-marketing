import { db } from "hatchable";
import crypto from "node:crypto";
import { requireAdminSession, getAdminSessionHash } from "../../lib/admin-auth.js";
import { getNetworkUser } from "../../lib/network-auth.js";
export const access = "public";
export const methods = ["GET","POST","DELETE"];
const COOKIE = "together_admin_marketer_preview";
const MAX_AGE = 30 * 60;
const digest = value => crypto.createHash("sha256").update(String(value)).digest("hex");
function readCookie(req) {
  if (req.cookies?.[COOKIE]) return String(req.cookies[COOKIE]);
  for (const part of String(req.headers?.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === COOKIE) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); }
      catch { return part.slice(i + 1).trim(); }
    }
  }
  return "";
}
function setCookie(res, token, maxAge = MAX_AGE) {
  res.cookie(COOKIE, token, { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge });
}
export default async function(req,res) {
  try {
    if (req.method === "GET") {
      const user = await getNetworkUser(req);
      return res.json({ ok: true, active: user?.source === "admin-preview", marketer: user?.source === "admin-preview" ? user.name : null });
    }
    if (!(await requireAdminSession(req,res))) return;
    if (req.method === "DELETE") {
      const token = readCookie(req);
      if (token) await db.query("DELETE FROM admin_marketer_preview_sessions WHERE token_hash=$1", [digest(token)]);
      setCookie(res, "", 0);
      return res.json({ ok: true, active: false });
    }
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const marketerId = String(body.marketer_id || "").trim();
    if (!marketerId) return res.status(400).json({ ok:false, error:"missing_marketer_id" });
    const target = await db.query("SELECT id,display_name,role,deleted_at FROM app_profiles WHERE id=$1 AND role='marketer' LIMIT 1", [marketerId]);
    if (!target.rows.length || target.rows[0].deleted_at) return res.status(404).json({ ok:false, error:"marketer_not_found" });
    const adminSessionHash = getAdminSessionHash(req);
    if (!adminSessionHash) return res.status(401).json({ ok:false, error:"admin_login_required" });
    const token = crypto.randomBytes(32).toString("hex");
    await db.query("DELETE FROM admin_marketer_preview_sessions WHERE admin_session_hash=$1 OR expires_at<=now()", [adminSessionHash]);
    await db.query("INSERT INTO admin_marketer_preview_sessions(token_hash,admin_session_hash,marketer_id,expires_at) VALUES($1,$2,$3,now()+interval '30 minutes')", [digest(token),adminSessionHash,marketerId]);
    await db.query("INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'admin_marketer_preview','marketer',$2,$3::jsonb)", ["admin",marketerId,JSON.stringify({expires_minutes:30})]).catch(()=>{});
    setCookie(res, token);
    return res.json({ok:true,active:true,marketer_id:marketerId,marketer_name:target.rows[0].display_name,expires_in:MAX_AGE,redirect:"/marketer/dashboard/?admin_preview=1"});
  } catch (error) {
    return res.status(500).json({ok:false,error:"admin_marketer_preview_failed"});
  }
}