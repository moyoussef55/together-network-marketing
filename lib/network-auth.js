import { db } from "hatchable";
import crypto from "node:crypto";

const COOKIE = "together_network_session";
const PREVIEW_COOKIE = "together_admin_marketer_preview";
const MAX_AGE = 60 * 30;

export function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

const PASSWORD_ITERATIONS = 310000;
const toHex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2,"0")).join("");
function safeHexEqual(a,b) {
  const x=Buffer.from(String(a||""),"hex"), y=Buffer.from(String(b||""),"hex");
  return x.length>0 && x.length===y.length && crypto.timingSafeEqual(x,y);
}
export async function hashNetworkPassword(password) {
  const subtle=globalThis.crypto?.subtle;
  if(!subtle) throw new Error("webcrypto_subtle_unavailable");
  const salt=crypto.randomBytes(16).toString("hex");
  const enc=new TextEncoder();
  const key=await subtle.importKey("raw",enc.encode(String(password)),"PBKDF2",false,["deriveBits"]);
  const bits=await subtle.deriveBits({name:"PBKDF2",salt:enc.encode(salt),iterations:PASSWORD_ITERATIONS,hash:"SHA-256"},key,512);
  return "pbkdf2-sha256$"+PASSWORD_ITERATIONS+"$"+salt+"$"+toHex(bits);
}
export async function verifyNetworkPassword(password, savedHash) {
  const saved=String(savedHash||"");
  if(saved.startsWith("pbkdf2-sha256$")) {
    const parts=saved.split("$");
    if(parts.length!==4 || parts[0]!=="pbkdf2-sha256") return false;
    const iterations=Number(parts[1]), salt=parts[2], expected=parts[3];
    if(!Number.isInteger(iterations)||iterations<100000||iterations>1000000||!/^[a-f0-9]{32}$/i.test(salt)||!/^[a-f0-9]{128}$/i.test(expected)) return false;
    const subtle=globalThis.crypto?.subtle;
    if(!subtle) throw new Error("webcrypto_subtle_unavailable");
    const enc=new TextEncoder();
    const key=await subtle.importKey("raw",enc.encode(String(password)),"PBKDF2",false,["deriveBits"]);
    const bits=await subtle.deriveBits({name:"PBKDF2",salt:enc.encode(salt),iterations,hash:"SHA-256"},key,512);
    return safeHexEqual(toHex(bits),expected);
  }
  return safeHexEqual(digest(password),saved);
}

function cookieValue(req) {
  if (req.cookies?.[COOKIE]) return String(req.cookies[COOKIE]);
  const raw = String(req.headers?.cookie || "");
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === COOKIE) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return part.slice(i + 1).trim(); }
    }
  }
  return "";
}

function bearerValue(req) {
  const h = String(req.headers?.authorization || "");
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

export async function createNetworkSession(res, userId, rememberMe = false) {
  const token = crypto.randomBytes(32).toString("hex");
  const persistent = rememberMe === true;
  const cookieAge = persistent ? 30 * 24 * 60 * 60 * 1000 : 30 * 60 * 1000;
  await db.query("DELETE FROM network_auth_sessions WHERE expires_at<=now() OR user_id=$1", [String(userId)]);
  await db.query(
    "INSERT INTO network_auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+CASE WHEN $3 THEN interval '30 days' ELSE interval '30 minutes' END)",
    [String(userId), digest(token), persistent]
  );
  const options = { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: cookieAge };
  res.cookie(COOKIE, token, options);
  return token;
}

export async function clearNetworkSession(req, res) {
  const candidates = [cookieValue(req), bearerValue(req)].filter(Boolean);
  for (const token of candidates) {
    await db.query("DELETE FROM network_auth_sessions WHERE token_hash=$1", [digest(token)]);
  }
  res.cookie(COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
}

export async function getNetworkUser(req) {
  const rawCookie = String(req.headers?.cookie || "");
  let previewToken = String(req.cookies?.[PREVIEW_COOKIE] || "");
  if (!previewToken) for (const part of rawCookie.split(";")) { const i=part.indexOf("="); if(i>0&&part.slice(0,i).trim()===PREVIEW_COOKIE){try{previewToken=decodeURIComponent(part.slice(i+1).trim())}catch{previewToken=part.slice(i+1).trim()}break;} }
  if (previewToken) {
    const preview = await db.query(`SELECT p.id,p.email,p.display_name AS name,p.role,p.referral_code,p.status,p.deleted_at,p.login_blocked
      FROM admin_marketer_preview_sessions s
      JOIN network_admin_sessions a ON a.token_hash=s.admin_session_hash AND a.expires_at>now()
      JOIN app_profiles p ON p.id=s.marketer_id AND p.role='marketer'
      WHERE s.token_hash=$1 AND s.expires_at>now() AND p.deleted_at IS NULL
      LIMIT 1`, [crypto.createHash("sha256").update(String(previewToken)).digest("hex")]);
    const p=preview.rows[0];
    if(p && !p.deleted_at) return {...p,source:"admin-preview",admin_preview:true};
  }
  const candidates = [cookieValue(req), bearerValue(req)].filter(Boolean);
  for (const token of candidates) {
    const q = await db.query(
      `SELECT p.id,p.email,p.display_name AS name,p.role,p.referral_code,p.status,p.deleted_at,p.login_blocked
         FROM network_auth_sessions s
         JOIN app_profiles p ON p.id=s.user_id
        WHERE s.token_hash=$1 AND s.expires_at>now()
        LIMIT 1`,
      [digest(token)]
    );
    const p = q.rows[0];
    if (p) {
      if (p.deleted_at || p.login_blocked || ["blocked","deleted"].includes(String(p.status || "").toLowerCase())) {
        await db.query("DELETE FROM network_auth_sessions WHERE token_hash=$1", [digest(token)]);
        return null;
      }
      return { ...p, source: "network-password" };
    }
  }

  // Keep existing Hatchable sessions working during the transition.
  const platformId = req.user?.id;
  if (platformId) {
    const q = await db.query(
      "SELECT id,email,display_name AS name,role,referral_code,status,deleted_at,login_blocked FROM app_profiles WHERE id=$1 LIMIT 1",
      [String(platformId)]
    );
    const p = q.rows[0];
    if (p && !p.deleted_at && !p.login_blocked && !["blocked","deleted"].includes(String(p.status || "").toLowerCase())) {
      return { ...p, source: "hatchable" };
    }
    if (p) return null;
    return { id: String(platformId), email: req.user.email || null, name: req.user.name || null, role: req.user.role || null, source: "hatchable" };
  }
  return null;
}

export async function requireNetworkUser(req, res) {
  const user = await getNetworkUser(req);
  if (!user) {
    res.status(401).json({ error: "login_required" });
    return null;
  }
  if (user.role && user.role !== "marketer") {
    res.status(403).json({ error: "marketer_only" });
    return null;
  }
  return user;
}

export { COOKIE, MAX_AGE };