import { db, email, storage, config } from "hatchable";
import crypto from "node:crypto";

const esc = value => String(value ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
const fmtDate = value => { const d = value ? new Date(value) : new Date(); return Number.isNaN(d.getTime()) ? String(value || "—") : d.toLocaleString("ar-EG", { timeZone: "Africa/Cairo" }); };
const digest = value => crypto.createHash("sha256").update(String(value)).digest("hex");

export async function sendAgentWelcomeEmail({ application, memberId, referralCode, joinedAt, accountPosition, slotNo, ibnAmount }) {
  const appId = application?.id;
  const to = String(application?.email || "").trim().toLowerCase();
  if (!appId || !to) return { sent: false, error: "missing_application_or_email" };
  try {
    const registrationMode = application?.registration_mode === "online" ? "online" : "offline";
    const allMedia = [
      ["national_id_front", "صورة البطاقة الشخصية — الوجه الأمامي", application.national_id_front_key],
      ["national_id_back", "صورة البطاقة الشخصية — الوجه الخلفي", application.national_id_back_key],
      ["paper_contract", "صورة العقد الورقي", application.paper_contract_key],
      ["declaration_image", "صورة الإقرار", application.declaration_image_key],
      ["voice_recording", "التسجيل الصوتي", application.voice_recording_key]
    ];
    const media = allMedia.filter(([kind]) =>
      registrationMode === "offline" || !["paper_contract", "voice_recording"].includes(kind)
    );
    // Revoke any previously issued bearer links before sending a fresh set.
    await db.query("UPDATE agent_document_access_tokens SET revoked_at=now() WHERE application_id=$1 AND revoked_at IS NULL",[appId]);
    const links = await Promise.all(media.map(async ([kind,label,key]) => {
      if (!key) throw new Error("registration_media_missing_" + kind);
      const token = crypto.randomBytes(32).toString("hex");
      await db.query("INSERT INTO agent_document_access_tokens(application_id,media_kind,storage_key,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '30 days')",[appId,kind,key,digest(token)]);
      const rawKey = String(key || "");
      const keyExt = (rawKey.match(/\\.([a-z0-9]{2,5})(?:$|[?#])/i) || [])[1];
      const fallbackExt = kind === "voice_recording" ? "webm" : "jpg";
      const ext = (keyExt || fallbackExt).toLowerCase();
      const safeBase = ({
        national_id_front: "national-id-front",
        national_id_back: "national-id-back",
        paper_contract: "paper-contract",
        declaration_image: "declaration",
        voice_recording: "voice-recording"
      })[kind] || kind;
      return { label, filename: safeBase + "." + ext, url: "https://together-network.hatchable.site/api/agent-document?token=" + token };
    }));
    const fullName = [application.first_name,application.second_name,application.third_name,application.fourth_name].filter(Boolean).join(" ") || "مسوق Together";
    const position = accountPosition == null ? "—" : String(accountPosition).padStart(2,"0");
    const slot = Number(slotNo) === 1 ? "01" : Number(slotNo) === 2 ? "02" : "—";
    const amount = Number(ibnAmount);
    const amountText = Number.isFinite(amount) ? amount.toLocaleString("ar-EG") : String(ibnAmount ?? "—");
    const fields = [["الاسم الكامل",fullName],["رقم الـ ID الخاص بك",referralCode || memberId],["البريد الإلكتروني المسجل",to],["تاريخ الانضمام",fmtDate(joinedAt)],["رقم التوكيل",position],["المربع داخل الشبكة",slot],["طريقة التسجيل",registrationMode === "online" ? "أونلاين" : "أوفلاين"],["الدولة",application.country],["المحافظة",application.state],["المدينة",application.city],["رقم الهاتف",application.phone]].filter(([,v]) => v !== null && v !== undefined && String(v).trim() !== "");
    const rows = fields.map(([k,v]) => '<tr><th style="text-align:right;padding:8px;border-bottom:1px solid #e5e7eb;white-space:nowrap">' + esc(k) + '</th><td style="padding:8px;border-bottom:1px solid #e5e7eb">' + esc(v) + '</td></tr>').join("");
    const fileHtml = links.map(x => '<li style="margin:10px 0"><a href="' + esc(x.url) + '" style="color:#1769aa;text-decoration:underline">' + esc(x.label) + '</a> — مرفق إن أمكن، أو افتح الرابط لتنزيل الملف</li>').join("");
    const fileText = links.map(x => x.label + " — رابط الملف: " + x.url).join("\n");
    const subject = "تهانينا بانضمامك إلى فريق Together 🎉";
    const intro = "شركة توجيذر للتسويق الإلكتروني ترحب بك، ونشكرك على إبداء رغبتك في الانضمام إلينا ضمن فريق التسويق.";
    const encouragement = "نتمنى لك كل التوفيق والنجاح، ونذكّرك بأهمية الالتزام بالتدريبات واتباع توجيهات مدربك لتحقيق أفضل النتائج.";
    const legal = registrationMode === "online"
      ? "وصول هذه الرسالة إليك يُعد إشعارًا باكتمال تسجيلك. يُرجى الاحتفاظ بنسخة الإقرار والاطلاع على الشروط التي وافقت عليها أثناء التسجيل الإلكتروني."
      : "وصول هذه الرسالة إليك يُعد إشعارًا باكتمال تسجيلك. ويُرجى الرجوع إلى العقد الورقي والإقرار والتسجيل الصوتي للاطلاع على الشروط والإقرارات التي وافقت عليها أثناء التسجيل.";
    const fee = "ويُرجى التذكير أن تكلفة إنشاء هذا الحساب الإلكتروني هي " + amountText + " جنيه، وغير قابلة للاسترداد.";
    const html = '<div dir="rtl" lang="ar" style="font-family:Arial,sans-serif;max-width:700px;margin:auto;padding:24px;color:#182332;line-height:1.8"><h2>تهانينا ' + esc(fullName) + ' 🎉</h2><p>' + esc(intro) + '</p><p>' + esc(encouragement) + '</p><h3>نسخة من بيانات التسجيل الخاصة بك</h3><table style="width:100%;border-collapse:collapse">' + rows + '</table><ul>' + fileHtml + '</ul><p>' + esc(legal) + '</p><p><strong>' + esc(fee) + '</strong></p><p>مع أطيب التمنيات بالنجاح والتوفيق،<br>فريق دعم Together</p></div>';
    const text = "تهانينا " + fullName + " 🎉\n\n" + intro + "\n\n" + encouragement + "\n\nنسخة من بيانات التسجيل الخاصة بك\n" + fields.map(([k,v]) => k + ": " + v).join("\n") + "\n\nروابط ملفات التسجيل الآمنة (صالحة لمدة 30 يومًا وتُفتح دون تسجيل الدخول إلى توجيذر):\n" + fileText + "\n\n" + legal + "\n\n" + fee + "\n\nمع أطيب التمنيات بالنجاح والتوفيق،\nفريق دعم Together";
    const webAppUrl = String((await config.get("TOGETHER_GMAIL_WEBAPP_URL")) || "").trim();
    const sharedSecret = String((await config.get("TOGETHER_GMAIL_SHARED_SECRET")) || "").trim();
    if (!webAppUrl || !webAppUrl.startsWith("https://script.google.com/macros/s/") || !webAppUrl.endsWith("/exec")) {
      throw new Error("gmail_sender_not_configured_webapp_url");
    }
    if (!sharedSecret) throw new Error("gmail_sender_not_configured_shared_secret");
    const response = await fetch(webAppUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: sharedSecret, to, subject, html, text,
        registration_mode: registrationMode,
        attachments: links.map(({ filename, url }) => ({ filename, url })),
        attachments_required: true
      }),
      redirect: "follow"
    });
    const responseText = await response.text();
    let result;
    try { result = JSON.parse(responseText); } catch { throw new Error("gmail_sender_invalid_response_http_" + response.status); }
    if (!response.ok || result?.success !== true) {
      throw new Error("gmail_sender_failed_" + String(result?.error || ("http_" + response.status)).slice(0,250));
    }
    if (Number(result?.attachments_sent) !== links.length) {
      throw new Error("gmail_sender_attachment_count_mismatch_expected_" + links.length + "_got_" + String(result?.attachments_sent ?? "missing") + "_update_apps_script");
    }
    await db.query("UPDATE network_agent_applications SET welcome_email_status='sent',welcome_email_sent_at=now(),welcome_email_error=NULL WHERE id=$1",[appId]);
    return { sent: true, message_id: null, provider: "google_apps_script" };
  } catch (err) {
    const message = String(err?.message || err || "email_send_failed").slice(0,500);
    console.error("agent welcome email failed", appId, message);
    try { await db.query("UPDATE network_agent_applications SET welcome_email_status='failed',welcome_email_error=$2 WHERE id=$1",[appId,message]); } catch (dbErr) { console.error("welcome email status update failed",String(dbErr?.message||dbErr)); }
    return { sent: false, error: message };
  }
}