import { requireAdminSession } from "../../lib/admin-auth.js";

export const access = "public";
export const methods = ["POST"];
const allowedSchema = ["Organization","WebSite","EducationalOrganization","LocalBusiness"];
export default async function(req,res) {
  if (!(await requireAdminSession(req,res))) return;
  let body = req.body || {};
  if (typeof body === "string") { try { body = JSON.parse(body || "{}"); } catch { return res.status(400).json({ok:false,error:"invalid_json"}); } }
  const topic = String(body.topic || "").trim().slice(0,1200);
  const keywords = String(body.keywords || "").trim().slice(0,600);
  const content = String(body.content || "").trim().slice(0,5000);
  const language = body.language === "en" ? "English" : "Arabic";
  if (!topic && !content) return res.status(400).json({ok:false,error:"topic_or_content_required",message:"أدخل موضوع الصفحة أو محتواها أولًا."});
  const apiKey = String(process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) return res.status(503).json({ok:false,error:"gemini_key_missing",message:"أضف GEMINI_API_KEY إلى متغيرات البيئة السرية على Namecheap ثم أعد تشغيل التطبيق."});
  try {
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key="+encodeURIComponent(apiKey), {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      signal:AbortSignal.timeout(45000),
      body:JSON.stringify({
        systemInstruction:{parts:[{text:"You are a careful technical SEO editor. Never invent facts or promise rankings. Return ONLY one compact valid JSON object with keys title, description, keywords, ogTitle, ogDescription, schemaType, focusPhrase, suggestions. Keep title concise, description about 140-160 characters when natural, keywords to 5-8 phrases, and suggestions to exactly 3 short actionable tips. schemaType must be Organization, WebSite, EducationalOrganization, or LocalBusiness. Do not include markdown or extra text. Write all values in "+language+"."}]},
        contents:[{role:"user",parts:[{text:JSON.stringify({topic,keywords,content,site:"Together Network Marketing",primaryDomain:"https://marketing.together-v-egp.com"})}]}],
        generationConfig:{temperature:0.3,maxOutputTokens:1800,responseMimeType:"application/json"}
      })
    });
    const result = await response.json().catch(()=>({}));
    if (!response.ok) {
      const providerMessage = String(result?.error?.message || "");
      console.error("Gemini API rejected SEO generation",response.status,result?.error?.status||"provider_error");
      const status = response.status === 429 ? 429 : response.status === 401 || response.status === 403 ? 503 : 502;
      return res.status(status).json({ok:false,error:response.status===429?"gemini_rate_limited":"gemini_request_failed",message:response.status===429?"وصلت خدمة Gemini إلى حد الاستخدام مؤقتًا. حاول لاحقًا.":response.status===401||response.status===403?"تحقق من صلاحية مفتاح Gemini وإتاحة Gemini API للمفتاح.":"تعذر توليد بيانات SEO عبر Gemini الآن."});
    }
    const candidate = result?.candidates?.[0];
    if (!candidate) return res.status(502).json({ok:false,error:"gemini_empty_response"});
    if (candidate.finishReason === "MAX_TOKENS") return res.status(502).json({ok:false,error:"ai_output_truncated",message:"كانت استجابة Gemini أطول من الحد المسموح؛ اختصر المحتوى وحاول مجددًا."});
    const raw = String(candidate.content?.parts?.map(p=>p.text||"").join("") || "").trim();
    let data;
    try { data = JSON.parse(raw); } catch { return res.status(502).json({ok:false,error:"ai_invalid_output",message:"أعاد Gemini تنسيقًا غير متوقع. حاول مرة أخرى."}); }
    const take = (v,n) => String(v ?? "").trim().slice(0,n);
    const suggestions = Array.isArray(data.suggestions) ? data.suggestions.slice(0,3).map(x=>take(x,240)).filter(Boolean) : [];
    return res.json({ok:true,seo:{
      title:take(data.title,180),description:take(data.description,320),keywords:take(data.keywords,600),
      ogTitle:take(data.ogTitle || data.title,180),ogDescription:take(data.ogDescription || data.description,320),
      schemaType:allowedSchema.includes(data.schemaType)?data.schemaType:"Organization",
      focusPhrase:take(data.focusPhrase,180),suggestions
    }});
  } catch(e) {
    console.error("SEO Gemini generation failed",e?.name||"Error");
    return res.status(502).json({ok:false,error:"seo_ai_failed",message:"تعذر الاتصال بخدمة Gemini الآن. حاول مرة أخرى."});
  }
}
