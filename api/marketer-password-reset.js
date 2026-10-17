import { db, email } from "hatchable";
import crypto from "node:crypto";

export const access = "public";
export const methods = ["POST"];

const digest = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const generic = { ok: true, message: "If this email belongs to an active marketer account, a reset link will be sent." };

export default async function(req,res) {
  const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const action = String(b.action || "request");
  if (action === "request") {
    const address = String(b.email || "").trim().toLowerCase();
    if (!address || address.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      return res.status(400).json({ error: "valid_email_required" });
    }
    const q = await db.query(
      "SELECT id,email,display_name,status,deleted_at,login_blocked FROM app_profiles WHERE lower(email)=lower($1) AND role='marketer' LIMIT 1",
      [address]
    );
    const p = q.rows[0];
    if (!p || p.deleted_at || p.login_blocked || ["blocked","deleted"].includes(String(p.status || "").toLowerCase())) {
      return res.json(generic);
    }
    const recent = await db.query(
      "SELECT count(*)::int AS n FROM marketer_password_resets WHERE user_id=$1 AND created_at>now()-interval '1 hour'",
      [String(p.id)]
    );
    if (Number(recent.rows[0]?.n || 0) >= 3) return res.status(429).json({ error: "reset_rate_limited" });

    const token = crypto.randomBytes(32).toString("hex");
    await db.query("UPDATE marketer_password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL", [String(p.id)]);
    await db.query(
      "INSERT INTO marketer_password_resets(user_id,email,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '30 minutes')",
      [String(p.id), address, digest(token)]
    );
    const base = "https://together-network.hatchable.site";
    const link = base + "/reset-password.html?token=" + encodeURIComponent(token);
    const safeName = String(p.display_name || "مسوق Together").replace(/[&<>"]/g, ch => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[ch]));
    try {
      await email.send({
        to: address,
        subject: "إعادة تعيين كلمة السر — Together Network",
        html: `<div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:24px;color:#182332"><h2>إعادة تعيين كلمة السر</h2><p>مرحبًا ${safeName}،</p><p>تلقينا طلبًا لإعادة تعيين كلمة السر لحسابك في Together Network.</p><p><a href="${link}" style="display:inline-block;background:#182332;color:#fff;padding:13px 22px;border-radius:10px;text-decoration:none">إعادة تعيين كلمة السر</a></p><p>ينتهي الرابط خلال 30 دقيقة ويُستخدم مرة واحدة فقط. إذا لم تطلب ذلك، يمكنك تجاهل هذه الرسالة.</p></div>`,
        text: `إعادة تعيين كلمة السر لحساب Together Network. افتح الرابط التالي خلال 30 دقيقة: ${link}\nإذا لم تطلب ذلك فتجاهل الرسالة.`
      });
    } catch (err) {
      console.error("marketer password reset email failed", String(err?.message || err));
      return res.status(503).json({ error: "email_delivery_unavailable" });
    }
    return res.json(generic);
  }

  if (action === "reset") {
    const token = String(b.token || "");
    const password = String(b.password || "");
    if (!/^[a-f0-9]{64}$/i.test(token)) return res.status(400).json({ error: "invalid_or_expired_token" });
    if (password.length < 8 || password.length > 200) return res.status(400).json({ error: "password_too_short", min_length: 8 });
    const q = await db.query(
      "SELECT id,user_id FROM marketer_password_resets WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() LIMIT 1",
      [digest(token)]
    );
    const reset = q.rows[0];
    if (!reset) return res.status(400).json({ error: "invalid_or_expired_token" });
    const profile = await db.query("SELECT id,status,deleted_at,login_blocked FROM app_profiles WHERE id=$1 AND role='marketer' LIMIT 1", [String(reset.user_id)]);
    const p = profile.rows[0];
    if (!p || p.deleted_at || p.login_blocked || ["blocked","deleted"].includes(String(p.status || "").toLowerCase())) {
      return res.status(400).json({ error: "invalid_or_expired_token" });
    }
    const hash = digest(password);
    await db.query("UPDATE app_profiles SET login_password_hash=$2 WHERE id=$1", [String(p.id), hash]);
    await db.query("UPDATE network_agent_applications SET password_hash=$2 WHERE member_id=$1", [String(p.id), hash]).catch(()=>{});
    await db.query("UPDATE marketer_password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL", [String(p.id)]);
    await db.query("DELETE FROM network_auth_sessions WHERE user_id=$1", [String(p.id)]).catch(()=>{});
    return res.json({ ok: true });
  }
  return res.status(400).json({ error: "invalid_action" });
}