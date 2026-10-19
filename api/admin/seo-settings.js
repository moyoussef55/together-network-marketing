import { db } from "hatchable";
import { requireAdminSession } from "../../lib/admin-auth.js";

export const access = "public";
export const methods = ["GET", "POST"];

const defaults = {
  siteName: "Together Network Marketing",
  title: "Together Network Marketing | شبكة تسويق ومبيعات",
  description: "اكتشف Together Network Marketing، منصة لإدارة شبكة الفريق ومتابعة المبيعات والإنجازات.",
  keywords: "Together Network Marketing, التسويق الشبكي, إدارة فريق المبيعات",
  canonicalUrl: "https://marketing.together-v-egp.com/",
  ogTitle: "Together Network Marketing",
  ogDescription: "منصة Together Network Marketing لإدارة الفريق والمبيعات.",
  ogImage: "",
  robots: "index,follow",
  schemaType: "Organization",
  organizationName: "Together Network Marketing",
  organizationUrl: "https://marketing.together-v-egp.com/",
  organizationLogo: "",
  language: "ar"
};
const limits = {siteName:120,title:180,description:320,keywords:600,canonicalUrl:500,ogTitle:180,ogDescription:320,ogImage:1000,robots:80,schemaType:40,organizationName:180,organizationUrl:500,organizationLogo:1000,language:8};
function clean(input = {}) {
  const out = {};
  for (const [key, max] of Object.entries(limits)) out[key] = String(input[key] ?? defaults[key]).trim().slice(0,max);
  for (const key of ["canonicalUrl","organizationUrl"]) {
    try { const u = new URL(out[key]); if (!["https:","http:"].includes(u.protocol)) throw 0; out[key] = u.href; }
    catch { out[key] = defaults[key]; }
  }
  for (const key of ["ogImage","organizationLogo"]) {
    if (out[key]) { try { const u = new URL(out[key]); if (u.protocol !== "https:") throw 0; out[key] = u.href; } catch { out[key] = ""; } }
  }
  out.robots = ["index,follow","noindex,follow","index,nofollow","noindex,nofollow"].includes(out.robots) ? out.robots : defaults.robots;
  out.schemaType = ["Organization","WebSite","EducationalOrganization","LocalBusiness"].includes(out.schemaType) ? out.schemaType : "Organization";
  out.language = ["ar","en"].includes(out.language) ? out.language : "ar";
  return out;
}
export default async function(req,res) {
  if (!(await requireAdminSession(req,res))) return;
  try {
    if (req.method === "GET") {
      const r = await db.query("SELECT settings, updated_at FROM seo_settings WHERE id=1 LIMIT 1");
      return res.setHeader("Cache-Control","no-store").json({ok:true,settings:{...defaults,...(r.rows[0]?.settings||{})},updatedAt:r.rows[0]?.updated_at||null});
    }
    let body = req.body || {};
    if (typeof body === "string") { try { body = JSON.parse(body || "{}"); } catch { return res.status(400).json({ok:false,error:"invalid_json"}); } }
    const settings = clean(body);
    await db.query("INSERT INTO seo_settings(id,settings,updated_at) VALUES(1,$1::jsonb,now()) ON CONFLICT(id) DO UPDATE SET settings=EXCLUDED.settings,updated_at=now()",[JSON.stringify(settings)]);
    return res.setHeader("Cache-Control","no-store").json({ok:true,saved:true,settings});
  } catch (e) {
    console.error("admin SEO settings failed",e);
    return res.status(500).json({ok:false,error:"seo_settings_failed"});
  }
}
