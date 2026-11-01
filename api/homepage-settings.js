import { db } from "hatchable";
export const access = "public";
export const methods = ["GET"];
const defaults = {brand:"Together Digital Marketing",eyebrow:"منظومة تسويق تعتمد على المبيعات الحقيقية",title:"ابنِ نجاحك مع شبكة أقوى",description:"منصة تجمع المنتجات والمبيعات الحقيقية وشبكة فريق واضحة، مع متابعة دقيقة للعمولات والإنجازات.",primaryText:"ابدأ رحلتك",primaryLink:"/login",secondaryText:"اكتشف المميزات",secondaryLink:"#features",template:"midnight",primaryColor:"#42d6a4",accentColor:"#5ca8ff",backgroundColor:"#07111f",textColor:"#f5f7fb",media:[]};
export default async function(req,res){
 try { const r=await db.query("SELECT settings FROM homepage_settings WHERE id=1 LIMIT 1"); const saved=r.rows[0]?.settings||{}; return res.setHeader("Cache-Control","no-store").json({ok:true,settings:{...defaults,...saved,media:Array.isArray(saved.media)?saved.media:defaults.media}}); }
 catch(e){console.error("homepage settings read failed",e);return res.status(200).json({ok:true,settings:defaults});}
}