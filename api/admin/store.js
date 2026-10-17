import { db, storage } from "hatchable";
import crypto from "node:crypto";

import { requireAdminSession } from "../../lib/admin-auth.js";
export const access = "public";
export const methods=["GET","POST"];

const clean=v=>String(v??"").trim();
const body=req=>typeof req.body==="string"?JSON.parse(req.body||"{}"):(req.body||{});

function slugify(s){
  const base=clean(s).toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g,"-").replace(/^-+|-+$/g,"").slice(0,60)||"product";
  return base+"-"+crypto.randomUUID().slice(0,8);
}

export default async function(req,res){if(!(await requireAdminSession(req,res)))return;
  if(req.method==="GET"){
    const view = new URL(req.url,"http://localhost").searchParams.get("view") || "";
    if (view === "orders") {
      const orders = await db.query("SELECT o.id,o.fulfillment_status AS status,o.total,o.created_at,o.shipping_country,o.shipping_governorate,o.shipping_address,o.shipping_phone,o.marketer_id,COALESCE(p.display_name,p.referral_code,o.marketer_id) AS marketer_name,p.referral_code,p.email AS marketer_email,p.phone AS marketer_phone,COALESCE(json_agg(json_build_object('product_id',oi.product_id,'name',pr.name,'quantity',oi.quantity,'unit_price',oi.unit_price,'bv',oi.bv,'selected_size',oi.selected_size,'selected_color',oi.selected_color) ORDER BY oi.id) FILTER(WHERE oi.id IS NOT NULL),'[]') AS items FROM orders o LEFT JOIN app_profiles p ON p.id=o.marketer_id LEFT JOIN order_items oi ON oi.order_id=o.id LEFT JOIN products pr ON pr.id=oi.product_id GROUP BY o.id,p.display_name,p.referral_code,p.email,p.phone ORDER BY o.created_at DESC LIMIT 500");
      return res.json({ok:true,orders:orders.rows});
    }
    const cats=await db.query("SELECT id,name,slug,active,created_at FROM store_categories ORDER BY active DESC,created_at ASC");
    const products=await db.query(`SELECT p.id,p.name,p.description,p.short_description,p.price,p.original_price,p.countdown_end_at,p.product_type,p.sizes,p.colors,p.videos,p.stock,p.bv,p.active,p.created_at,p.category_id,c.name AS category_name
      FROM products p LEFT JOIN store_categories c ON c.id=p.category_id
      ORDER BY p.created_at DESC`);
    const images=await db.query("SELECT id,product_id,storage_key,sort_order FROM product_images ORDER BY sort_order ASC,created_at ASC");
    const imageRows=await Promise.all(images.rows.map(async x=>({...x,url:await storage.url(x.storage_key)})));
    const byProduct=new Map(); for(const x of imageRows){if(!byProduct.has(x.product_id))byProduct.set(x.product_id,[]);byProduct.get(x.product_id).push(x)}
    for(const p of products.rows)p.images=byProduct.get(p.id)||[];
    return res.json({ok:true,categories:cats.rows,products:products.rows});
  }
  const b=body(req),action=clean(b.action);
  if(action==="update_order_status"){
    const orderId=clean(b.order_id),status=clean(b.status);
    const allowed=["جارى معالجة الطلب","تم استلام الطلب","تم الشحن","جارى التواصل","تم التسليم"];
    if(!orderId||!allowed.includes(status))return res.status(400).json({error:"invalid_order_status"});
    const updated=await db.query("UPDATE orders SET fulfillment_status=$1 WHERE id=$2 RETURNING id,fulfillment_status AS status,total,created_at",[status,orderId]);
    if(!updated.rows.length)return res.status(404).json({error:"order_not_found"});
    return res.json({ok:true,order:updated.rows[0]});
  }
  if(action==="category"){
    const name=clean(b.name);
    if(!name)return res.status(400).json({error:"category_name_required"});
    const slug=slugify(name);
    const r=await db.query("INSERT INTO store_categories(name,slug) VALUES($1,$2) RETURNING id,name,slug,active",[name,slug]);
    return res.status(201).json({ok:true,category:r.rows[0]});
  }
  if(action==="toggle_product"){
    const id=clean(b.product_id);
    const r=await db.query("UPDATE products SET active=NOT active WHERE id=$1 RETURNING id,active",[id]);
    if(!r.rows.length)return res.status(404).json({error:"product_not_found"});
    return res.json({ok:true,product:r.rows[0]});
  }
  if(action==="upload_image"){
    const productId=clean(b.product_id);
    const file=(req.files||[]).find(f=>f.field==="file");
    if(!productId||!file)return res.status(400).json({error:"product_and_file_required"});
    const allowed=new Set(["image/jpeg","image/png","image/webp","image/gif"]);
    if(!allowed.has(file.contentType))return res.status(415).json({error:"image_type_not_supported"});
    if(file.buffer.length>8*1024*1024)return res.status(413).json({error:"image_too_large"});
    const product=await db.query("SELECT id FROM products WHERE id=$1",[productId]);
    if(!product.rows.length)return res.status(404).json({error:"product_not_found"});
    const ext=(file.filename.split(".").pop()||"jpg").toLowerCase().replace(/[^a-z0-9]/g,"")||"jpg";
    const key="store/products/"+productId+"/"+crypto.randomUUID()+"."+ext;
    await storage.put(key,file.buffer,file.contentType);
    const r=await db.query("INSERT INTO product_images(product_id,storage_key,sort_order) VALUES($1,$2,(SELECT COALESCE(MAX(sort_order),0)+1 FROM product_images WHERE product_id=$1)) RETURNING id,product_id,storage_key,sort_order",[productId,key]);
    return res.status(201).json({ok:true,image:{...r.rows[0],url:await storage.url(key)}});
  }
  if(action==="delete_image"){
    const imageId=clean(b.image_id); const r=await db.query("DELETE FROM product_images WHERE id=$1 RETURNING storage_key",[imageId]);
    if(!r.rows.length)return res.status(404).json({error:"image_not_found"}); await storage.del(r.rows[0].storage_key); return res.json({ok:true});
  }
  if(action==="update_product"){
    const id=clean(b.product_id),name=clean(b.name),description=clean(b.description),shortDescription=clean(b.short_description),price=Number(b.price),originalPrice=b.original_price===""||b.original_price==null?null:Number(b.original_price),stock=Math.max(0,Math.floor(Number(b.stock))),bv=Math.max(0,Math.floor(Number(b.bv??1000))),categoryId=clean(b.category_id)||null,active=b.active!==false,productType=clean(b.product_type)==="clothing"?"clothing":"general",countdownEnd=clean(b.countdown_end_at)||null;
const parseList=v=>{if(Array.isArray(v))return v.map(x=>String(x??"").trim()).filter(Boolean);if(typeof v==="string"){try{const x=JSON.parse(v);if(Array.isArray(x))return x.map(y=>String(y??"").trim()).filter(Boolean)}catch{}return v.split(String.fromCharCode(10)).flatMap(x=>x.split(",")).flatMap(x=>x.split("،")).map(x=>x.trim()).filter(Boolean)}return []};
    const sizes=productType==="clothing"?parseList(b.sizes):[],colors=productType==="clothing"?parseList(b.colors):[],videos=parseList(b.videos).filter(u=>u.startsWith("https://")||u.startsWith("http://"));
    if(!id||!name)return res.status(400).json({error:"product_id_and_name_required"});
    if(!Number.isFinite(price)||price<0||!Number.isFinite(stock)||!Number.isFinite(bv)||(originalPrice!==null&&(!Number.isFinite(originalPrice)||originalPrice<price)))return res.status(400).json({error:"invalid_product_values"});
    if(countdownEnd&&Number.isNaN(Date.parse(countdownEnd)))return res.status(400).json({error:"invalid_countdown_date"});
    const r=await db.query("UPDATE products SET name=$1,description=$2,short_description=$3,price=$4,original_price=$5,stock=$6,bv=$7,category_id=$8,active=$9,countdown_end_at=$10,product_type=$11,sizes=$12::jsonb,colors=$13::jsonb,videos=$14::jsonb WHERE id=$15 RETURNING id,name,description,short_description,price,original_price,stock,bv,category_id,active,countdown_end_at,product_type,sizes,colors,videos,created_at",[name,description||null,shortDescription||null,price,originalPrice,stock,bv,categoryId,active,countdownEnd,productType,JSON.stringify(sizes),JSON.stringify(colors),JSON.stringify(videos),id]);
    if(!r.rows.length)return res.status(404).json({error:"product_not_found"}); return res.json({ok:true,product:r.rows[0]});
  }
  if(action==="delete_product"){
    const id=clean(b.product_id); const imgs=await db.query("SELECT storage_key FROM product_images WHERE product_id=$1",[id]);
    const r=await db.query("DELETE FROM products WHERE id=$1 RETURNING id",[id]);
    if(!r.rows.length)return res.status(404).json({error:"product_not_found"});
    for(const x of imgs.rows)await storage.del(x.storage_key); return res.json({ok:true});
  }
  if(action==="toggle_category"){
    const id=clean(b.category_id);
    const r=await db.query("UPDATE store_categories SET active=NOT active WHERE id=$1 RETURNING id,active",[id]);
    if(!r.rows.length)return res.status(404).json({error:"category_not_found"});
    return res.json({ok:true,category:r.rows[0]});
  }
  if(action==="product"){
    const name=clean(b.name),description=clean(b.description),shortDescription=clean(b.short_description),price=Number(b.price),originalPrice=b.original_price===""||b.original_price==null?null:Number(b.original_price),stock=Math.max(0,Math.floor(Number(b.stock))),bv=Math.max(0,Math.floor(Number(b.bv??1000))),categoryId=clean(b.category_id)||null,active=b.active!==false,productType=clean(b.product_type)==="clothing"?"clothing":"general",countdownEnd=clean(b.countdown_end_at)||null;
    const parseList=v=>{if(Array.isArray(v))return v.map(x=>String(x??"").trim()).filter(Boolean);if(typeof v==="string"){try{const x=JSON.parse(v);if(Array.isArray(x))return x.map(y=>String(y??"").trim()).filter(Boolean)}catch{}return v.split(String.fromCharCode(10)).flatMap(x=>x.split(",")).flatMap(x=>x.split("،")).map(x=>x.trim()).filter(Boolean)}return []};
    const sizes=productType==="clothing"?parseList(b.sizes):[],colors=productType==="clothing"?parseList(b.colors):[],videos=parseList(b.videos).filter(u=>u.startsWith("https://")||u.startsWith("http://"));
    if(!name)return res.status(400).json({error:"name_required"});
    if(!(price>=0)||!Number.isFinite(price)||(originalPrice!==null&&(!Number.isFinite(originalPrice)||originalPrice<price)))return res.status(400).json({error:"invalid_price"});
    if(!Number.isFinite(stock)||!Number.isFinite(bv))return res.status(400).json({error:"invalid_stock_or_bv"});
    if(countdownEnd&&Number.isNaN(Date.parse(countdownEnd)))return res.status(400).json({error:"invalid_countdown_date"});
    const slug=slugify(name);
    const r=await db.query(`INSERT INTO products(name,slug,description,short_description,price,original_price,stock,bv,category_id,commissionable,active,countdown_end_at,product_type,sizes,colors,videos)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,$11,$12,$13::jsonb,$14::jsonb,$15::jsonb)
      RETURNING id,name,description,short_description,price,original_price,stock,bv,category_id,active,countdown_end_at,product_type,sizes,colors,videos,created_at`,
      [name,slug,description||null,shortDescription||null,price,originalPrice,stock,bv,categoryId,active,countdownEnd,productType,JSON.stringify(sizes),JSON.stringify(colors),JSON.stringify(videos)]);
    return res.status(201).json({ok:true,product:r.rows[0]});
  }
  return res.status(400).json({error:"unknown_action"});
}