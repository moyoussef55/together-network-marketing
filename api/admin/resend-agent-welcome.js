import { db } from "hatchable";
import { sendAgentWelcomeEmail } from "../../lib/agent-welcome-email.js";
import { requireAdminSession } from "../../lib/admin-auth.js";

export const access = "public";
export const methods = ["POST"];

export default async function(req, res) {
  if (!(await requireAdminSession(req, res))) return;
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const applicationId = String(body.application_id || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(applicationId)) {
    return res.status(400).json({ ok: false, error: "invalid_application_id" });
  }

  const result = await db.query(
    "SELECT * FROM network_agent_applications WHERE id=$1 AND status='joined' AND member_id IS NOT NULL LIMIT 1",
    [applicationId]
  );
  if (!result.rows.length) return res.status(404).json({ ok: false, error: "joined_application_not_found" });

  const application = result.rows[0];
  const forceResend = body.force_resend === true;
  if (application.welcome_email_status === "sent" && !forceResend) {
    return res.status(409).json({
      ok: false,
      already_sent: true,
      message: "تم إرسال بيانات التسجيل لهذا المسوق سابقًا. هل تريد إرسالها مرة أخرى؟"
    });
  }
  if (forceResend && application.welcome_email_status !== "sent") {
    return res.status(409).json({ ok:false, error:"resend_confirmation_not_applicable" });
  }
  const member = await db.query("SELECT referral_code FROM app_profiles WHERE id=$1 LIMIT 1", [application.member_id]);
  const sent = await sendAgentWelcomeEmail({
    application,
    memberId: application.member_id,
    referralCode: member.rows[0]?.referral_code || application.member_id,
    joinedAt: application.joined_at,
    accountPosition: application.account_position,
    slotNo: application.slot_no,
    ibnAmount: application.ibn_amount
  });

  return res.status(sent.sent ? 200 : 503).json({
    ok: sent.sent,
    welcome_email_sent: sent.sent,
    error: sent.sent ? null : sent.error
  });
}