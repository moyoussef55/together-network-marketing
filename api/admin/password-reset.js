import { db, email, config } from "hatchable";
import crypto from "node:crypto";
import { passwordHash } from "../../lib/admin-auth.js";

export const access = "public";
export const methods = ["POST"];

const digest = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const generic = { ok: true, message: "إذا كان البريد يطابق حساب المدير، فسيتم إرسال رابط إعادة التعيين." };

export default async function(req, res) {
  try {
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const action = String(b.action || "request");
    if (action === "request") {
      const address = String(b.email || "").trim().toLowerCase();
      if (!address || address.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
        return res.status(400).json({ ok:false, error:"valid_email_required" });
      }
      const q = await db.query("SELECT email FROM network_admin_credentials WHERE id=1 AND lower(email)=lower($1) LIMIT 1", [address]);
      if (q.rows.length) {
        const recent = await db.query("SELECT count(*)::int AS n FROM network_admin_password_resets WHERE created_at > now()-interval '1 hour'");
        if (Number(recent.rows[0]?.n || 0) >= 5) return res.status(429).json({ ok:false, error:"reset_rate_limited" });
        const token = crypto.randomBytes(32).toString("hex");
        await db.query("UPDATE network_admin_password_resets SET used_at=now() WHERE used_at IS NULL");
        await db.query("INSERT INTO network_admin_password_resets(token_hash,expires_at) VALUES($1,now()+interval '30 minutes')", [digest(token)]);
        const publicBase = String(await config.get("PUBLIC_BASE_URL") || "https://together-network.hatchable.site").replace(/\/+$/, "");
        const link = publicBase + "/admin-reset-password.html?token=" + encodeURIComponent(token);
        try {
          await email.send({
            to: address,
            subject: "إعادة تعيين كلمة مرور مدير Together Network",
            html: '<div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:24px;color:#182332"><h2>إعادة تعيين كلمة المرور</h2><p>تلقينا طلبًا لإعادة تعيين كلمة مرور لوحة الإدارة.</p><p><a href="' + link + '" style="display:inline-block;background:#182332;color:#fff;padding:13px 22px;border-radius:10px;text-decoration:none">إعادة تعيين كلمة المرور</a></p><p>الرابط صالح لمدة 30 دقيقة ويُستخدم مرة واحدة فقط. إذا لم تطلب ذلك فتجاهل الرسالة.</p></div>',
            text: "لإعادة تعيين كلمة مرور لوحة إدارة Together Network افتح هذا الرابط خلال 30 دقيقة: " + link + "\nإذا لم تطلب ذلك فتجاهل الرسالة."
          });
        } catch (e) {
          console.error("admin password reset email failed", String(e?.message || e));
          return res.status(503).json({ ok:false, error:"email_delivery_unavailable" });
        }
      }
      return res.json(generic);
    }
    if (action === "reset") {
      const token = String(b.token || "");
      const password = String(b.password || "");
      if (!/^[a-f0-9]{64}$/i.test(token)) return res.status(400).json({ ok:false, error:"invalid_or_expired_token" });
      if (password.length < 12 || password.length > 200) return res.status(400).json({ ok:false, error:"password_too_short" });
      const q = await db.query("SELECT id FROM network_admin_password_resets WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() LIMIT 1", [digest(token)]);
      if (!q.rows.length) return res.status(400).json({ ok:false, error:"invalid_or_expired_token" });
      const salt = crypto.randomBytes(16).toString("hex");
      const hash = await passwordHash(password, salt);
      await db.query("UPDATE network_admin_credentials SET password_hash=$1,password_salt=$2,updated_at=now() WHERE id=1", [hash,salt]);
      await db.query("UPDATE network_admin_password_resets SET used_at=now() WHERE used_at IS NULL");
      await db.query("DELETE FROM network_admin_sessions");
      return res.json({ ok:true });
    }
    return res.status(400).json({ ok:false, error:"invalid_action" });
  } catch (e) {
    console.error("admin password reset failed", String(e?.message || e));
    return res.status(500).json({ ok:false, error:"password_reset_failed" });
  }
}