import { db } from "hatchable";
import crypto from "node:crypto";

const COOKIE = "together_admin_session";
const MAX_AGE = 60 * 30;

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}
function cookieToken(req) {
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
function setCookie(res, token, maxAge = MAX_AGE) {
  res.cookie(COOKIE, token, { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge });
}
function toHex(bytes) {
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}
export async function passwordHash(password, salt) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("webcrypto_subtle_unavailable");
  const enc = new TextEncoder();
  const key = await subtle.importKey("raw", enc.encode(String(password)), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "PBKDF2", salt: enc.encode(String(salt)), iterations: 310000, hash: "SHA-256" }, key, 512);
  return toHex(bits);
}
export async function safePasswordCheck(password, salt, expected) {
  const actual = await passwordHash(password, salt);
  const saved = String(expected || "");
  if (actual.length !== saved.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ saved.charCodeAt(i);
  return diff === 0;
}
export async function adminSetupStatus() {
  const r = await db.query("SELECT 1 FROM network_admin_credentials WHERE id=1 LIMIT 1");
  return Boolean(r.rows.length);
}
export async function issueAdminSession(res, rememberMe = false) {
  const token = crypto.randomBytes(32).toString("hex");
  const persistent = rememberMe === true;
  const cookieAge = persistent ? 10 * 365 * 24 * 60 * 60 * 1000 : MAX_AGE * 1000;
  await db.query("DELETE FROM network_admin_sessions WHERE expires_at<=now()");
  await db.query("INSERT INTO network_admin_sessions(token_hash,expires_at) VALUES($1,now()+CASE WHEN $2 THEN interval '10 years' ELSE interval '30 minutes' END)", [digest(token), persistent]);
  setCookie(res, token, cookieAge);
}
export async function clearAdminSession(req, res) {
  const token = cookieToken(req);
  if (token) await db.query("DELETE FROM network_admin_sessions WHERE token_hash=$1", [digest(token)]);
  setCookie(res, "", 0);
}
export function getAdminSessionHash(req) {
  const token = cookieToken(req);
  return token ? digest(token) : "";
}

export async function hasAdminSession(req) {
  const token = cookieToken(req);
  if (!token) return false;
  const r = await db.query("SELECT 1 FROM network_admin_sessions WHERE token_hash=$1 AND expires_at>now() LIMIT 1", [digest(token)]);
  return Boolean(r.rows.length);
}
export async function requireAdminSession(req, res) {
  const token = cookieToken(req);
  if (!token) { res.status(401).json({ ok:false, error:"admin_login_required" }); return false; }
  const r = await db.query("SELECT 1 FROM network_admin_sessions WHERE token_hash=$1 AND expires_at>now() LIMIT 1", [digest(token)]);
  if (!r.rows.length) { res.status(401).json({ ok:false, error:"admin_login_required" }); return false; }
  return true;
}
export { COOKIE, MAX_AGE };