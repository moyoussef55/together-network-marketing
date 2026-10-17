import { clearAdminSession } from "../../lib/admin-auth.js";
export const access = "public";
export const methods = ["POST"];
export default async function(req,res) {
  try { await clearAdminSession(req,res); return res.json({ ok:true }); }
  catch (e) { return res.status(500).json({ ok:false, error:"admin_logout_failed" }); }
}