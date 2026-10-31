import { adminSetupStatus, hasAdminSession } from "../../lib/admin-auth.js";
export const access = "public";
export const methods = ["GET"];
export default async function(req,res) {
  try {
    const configured = await adminSetupStatus();
    if (!configured) return res.json({ configured:false, authenticated:false });
    const authenticated = await hasAdminSession(req);
    return res.json({ configured:true, authenticated:Boolean(authenticated) });
  } catch (e) { return res.status(500).json({ error:"admin_status_failed" }); }
}