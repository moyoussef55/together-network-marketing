import { ai } from "hatchable";
import { requireAdminSession } from "../../lib/admin-auth.js";

export const access = "public";
export const methods = ["POST"];
export default async function(req,res) {
  if (!(await requireAdminSession(req,res))) return;
  let body = req.body || {};
  if (typeof body === "string") { try { body = JSON.parse(body || "{}"); } catch { return res.status(400).json({ok:false,error:"invalid_json"}); } }
  const topic = String(body.topic || "").trim().slice(0,1200);
  const keywords = String(body.keywords || "").trim().slice(0,600);
  const content = String(body.content || "").trim().slice(0,5000);
  const language = body.language === "en" ? "English" : "Arabic";
  if (!topic && !content) return res.status(400).json({ok:false,error:"topic_or_content_required",message:"أدخل موضوع الصفحة أو محتواها أولًا."});
  try {
    const result = await ai.generateText({
      purpose: "seo-metadata-generation",
      model: "gemini",
      maxTokens: 2400,
      system: "You are a careful technical SEO editor. Never invent facts or promise rankings. Return ONLY one compact valid JSON object with keys title, description, keywords, ogTitle, ogDescription, schemaType, focusPhrase, suggestions. Keep title concise, description about 140-160 characters when natural, keywords to 5-8 phrases, and suggestions to exactly 3 short actionable tips. schemaType must be Organization, WebSite, EducationalOrganization, or LocalBusiness. Do not include markdown or extra text. Write all values in " + language + ".",
      prompt: JSON.stringify({topic,keywords,content,site:"Together Network Marketing",primaryDomain:"https://marketing.together-v-egp.com"}),
    });
    if (result.finishReason === "length") return res.status(502).json({ok:false,error:"ai_output_truncated"});
    const raw = String(result.text || "").trim().replace(/^\x60{3}(?:json)?\s*/i,"").replace(/\s*\x60{3}$/,"");
    let data;
    try { data = JSON.parse(raw); } catch { return res.status(502).json({ok:false,error:"ai_invalid_output"}); }
    const take = (v,n) => String(v ?? "").trim().slice(0,n);
    const suggestions = Array.isArray(data.suggestions) ? data.suggestions.slice(0,5).map(x=>take(x,240)).filter(Boolean) : [];
    return res.json({ok:true,seo:{
      title:take(data.title,180),description:take(data.description,320),keywords:take(data.keywords,600),
      ogTitle:take(data.ogTitle || data.title,180),ogDescription:take(data.ogDescription || data.description,320),
      schemaType:["Organization","WebSite","EducationalOrganization","LocalBusiness"].includes(data.schemaType)?data.schemaType:"Organization",
      focusPhrase:take(data.focusPhrase,180),suggestions
    }});
  } catch(e) {
    console.error("SEO Gemini generation failed", e);
    const msg = String(e?.message || "");
    const setupMissing = /setup_required|no (?:OpenAI|Anthropic|Google) API key|no .* API key|\b412\b/i.test(msg);
    return res.status(502).json({ok:false,error:setupMissing?"ai_setup_required":"seo_ai_failed",message:setupMissing?"يحتاج Gemini إلى تفعيل مفتاح Google في إعدادات AI الخاصة بـ Hatchable؛ السر GEMINI_API_KEY المحفوظ في أسرار المشروع منفصل عن مفتاح بوابة AI.":"تعذر توليد بيانات SEO عبر Gemini الآن. حاول مرة أخرى."});
  }
}