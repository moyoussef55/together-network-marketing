import { db } from "hatchable";
import crypto from "node:crypto";
import { passwordHash, issueAdminSession } from "../../lib/admin-auth.js";
export const access = "public";
export const methods = ["POST"];
const SETUP_KEY_HASH = "20f97c99d8aba351d49f2aba9e2d9992e75f925a7270a5945723dc205040f3c9";
export default async function(req,res) {
  let stage = "parse_request";
  try {
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    stage = "validate_key";
    const suppliedKeyHash = crypto.createHash("sha256").update(String(b.setupKey || "")).digest("hex");
    const keyA = Buffer.from(suppliedKeyHash, "hex");
    const keyB = Buffer.from(SETUP_KEY_HASH, "hex");
    if (keyA.length !== keyB.length || !crypto.timingSafeEqual(keyA,keyB)) return res.status(403).json({ok:false,error:"invalid_setup_key"});
    const email = String(b.email || "").trim().toLowerCase();
    const password = String(b.password || "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ok:false,error:"invalid_email"});
    if (password.length < 12) return res.status(400).json({ok:false,error:"password_too_short"});
    stage = "hash_password";
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = await passwordHash(password,salt);
    stage = "insert_credentials";
    const result = await db.query("INSERT INTO network_admin_credentials(id,email,password_hash,password_salt) VALUES(1,$1,$2,$3) ON CONFLICT(id) DO NOTHING RETURNING id",[email,hash,salt]);
    if (!result.rows.length) return res.status(409).json({ok:false,error:"admin_already_configured"});
    stage = "issue_session";
    await issueAdminSession(res);
    return res.json({ok:true});
  } catch (e) {
    console.error("admin initial setup failed", stage, String(e?.code || ""), String(e?.message || ""));
    if (String(e?.code)==="23505") return res.status(409).json({ok:false,error:"admin_already_configured"});
    return res.status(500).json({ok:false,error:"admin_setup_failed",stage,code:String(e?.code || ""),detail:String(e?.message || "").slice(0,180)});
  }
}