import { db } from "hatchable";
export const access = "public";
export const methods = ["GET"];
const fallback = {siteName:"Together Digital Marketing",title:"Together Digital Marketing | منصة تسويق إلكتروني ومبيعات",description:"اكتشف Together Digital Marketing، منصة لإدارة شبكة الفريق ومتابعة المبيعات والإنجازات.",keywords:"Together Digital Marketing, التسويق الإلكتروني, إدارة فريق المبيعات",canonicalUrl:"https://marketing.together-v-egp.com/",ogTitle:"Together Digital Marketing",ogDescription:"منصة Together Digital Marketing لإدارة الفريق والمبيعات.",ogImage:"",robots:"index,follow",schemaType:"Organization",organizationName:"Together Digital Marketing",organizationUrl:"https://marketing.together-v-egp.com/",organizationLogo:"",language:"ar"};
export default async function(req,res) {
  try {
    const r = await db.query("SELECT settings FROM seo_settings WHERE id=1 LIMIT 1");
    const s = {...fallback,...(r.rows[0]?.settings||{})};
    return res.setHeader("Cache-Control","public, max-age=300, s-maxage=300").json({ok:true,settings:s});
  } catch(e) {
    console.error("public SEO read failed",e);
    return res.setHeader("Cache-Control","no-store").status(200).json({ok:true,settings:fallback});
  }
}