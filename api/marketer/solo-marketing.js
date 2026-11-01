import { db, storage } from "hatchable";
import crypto from "node:crypto";
import { requireNetworkUser } from "../../lib/network-auth.js";

export const access = "public";
export const methods = ["GET","POST"];

const clean = v => String(v ?? "").trim();
const parseBody = req => {
  if (typeof req.body === "string") { try { return JSON.parse(req.body || "{}"); } catch { return {}; } }
  return req.body || {};
};

export default async function(req,res) {
  const user=await requireNetworkUser(req,res);
  if(!user)return;
  const uid=String(user.id);
  const profile=await db.query("SELECT role,deleted_at,login_blocked,status FROM app_profiles WHERE id=$1",[uid]);
  if(!profile.rows.length||profile.rows[0].role!=="marketer"||profile.rows[0].deleted_at||profile.rows[0].login_blocked||["blocked","deleted"].includes(String(profile.rows[0].status||"").toLowerCase())) {
    return res.status(403).json({error:"marketer_only"});
  }

  if(req.method==="GET") {
    const [products,rates,orders]=await Promise.all([
      db.query("SELECT id,name,short_description,description,image_key,base_price,starting_price,min_price,max_price,stock,product_type,sizes,colors FROM solo_marketing_products WHERE active=true ORDER BY created_at DESC"),
      db.query("SELECT governorate,fee,active FROM solo_marketing_shipping_rates ORDER BY governorate"),
      db.query("SELECT id,order_code,product_name,buyer_full_name,buyer_phone,governorate,delivery_address,selected_size,selected_color,quantity,base_price,selling_price,commission,shipping_fee,total,status,confirmed_at,commission_credited_at,created_at,updated_at FROM solo_marketing_orders WHERE marketer_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 300",[uid])
    ]);
    const productsWithImages=await Promise.all(products.rows.map(async p=>({...p,image_url:p.image_key?await storage.url(p.image_key):null})));
    return res.json({ok:true,products:productsWithImages,shipping_rates:rates.rows,orders:orders.rows});
  }
  if(req.method!=="POST")return res.status(405).json({error:"method_not_allowed"});
  const b=parseBody(req);
  if(clean(b.action)!=="create_order")return res.status(400).json({error:"unknown_action"});
  const productId=clean(b.product_id);
  const price=Number(b.selling_price);
  const fullName=clean(b.buyer_full_name);
  const phone=clean(b.buyer_phone).replace(/[\s()-]/g,"");
  const governorate=clean(b.governorate);
  const address=clean(b.delivery_address);
  const size=clean(b.selected_size);
  const color=clean(b.selected_color);
  if(!productId||!Number.isFinite(price)||price<0||fullName.length<4||fullName.length>160||
     !/^\+?[0-9]{10,15}$/.test(phone)||governorate.length<2||address.length<8||address.length>1000) {
    return res.status(400).json({error:"invalid_or_missing_order_fields"});
  }
  const orderCode="SM-"+Date.now().toString(36).toUpperCase()+"-"+crypto.randomBytes(3).toString("hex").toUpperCase();
  try {
    const q=await db.query("SELECT create_solo_marketing_order($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS order_data",
      [uid,productId,price,fullName,phone,governorate,address,size,color,orderCode]);
    let order=q.rows[0]?.order_data||{};
    if(typeof order==="string"){try{order=JSON.parse(order)}catch{}}
    return res.status(201).json({ok:true,order,thank_you:"شكرًا لطلبك من Together. تم تسجيل طلبك بنجاح، ويمكنك متابعة حالته من قسم متابعة طلباتي."});
  } catch(error) {
    const message=String(error?.message||"order_failed").slice(0,180);
    return res.status(400).json({error:message});
  }
}