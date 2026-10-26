import { db } from "hatchable";
import { safePasswordCheck, issueAdminSession } from "../../lib/admin-auth.js";
export const access = "public";
export const methods = ["POST"];
export default async function(req,res) {
  try {
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const email = String(b.email || "").trim().toLowerCase();
    const password = String(b.password || "");
    if (!email || !password) return res.status(400).json({ ok:false, error:"missing_credentials" });
    const r = await db.query("SELECT email,password_hash,password_salt FROM network_admin_credentials WHERE id=1 LIMIT 1");
    const row = r.rows[0];
    if (!row || row.email !== email || !await safePasswordCheck(password,row.password_salt,row.password_hash)) {
      return res.status(401).json({ ok:false, error:"invalid_credentials" });
    }
    await issueAdminSession(res, b.rememberMe === true);
    return res.json({ ok:true });
  } catch (e) { return res.status(500).json({ ok:false, error:"admin_login_failed" }); }
}