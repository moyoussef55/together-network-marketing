import { db, storage } from "hatchable";
import crypto from "node:crypto";
import { requireAdminSession } from "../../lib/admin-auth.js";

export const access = "public";
export const methods = ["GET","POST"];

const clean = v => String(v ?? "").trim();
const parseBody = req => {
  if (typeof req.body === "string") { try { return JSON.parse(req.body || "{}"); } catch { return {}; } }
  return req.body || {};
};
const parseList = v => {
  if (Array.isArray(v)) return v.map(x=>String(x??"").trim()).filter(Boolean).slice(0,100);
  if (typeof v === "string") return v.split(/[\n,،]+/).map(x=>x.trim()).filter(Boolean).slice(0,100);
  return [];
};
const statuses = ["طلب جديد","قيد مراجعة الطلب","تم تأكيد الطلب","جاري التجهيز","تم الشحن","خرج للتوصيل","في الطريق","تم التسليم","تعذر التسليم","مؤجل","ملغي","مرتجع"];

export default async function(req,res) {
  if (!(await requireAdminSession(req,res))) return;
  if (req.method === "GET") {
    const view = new URL(req.url,"http://localhost").searchParams.get("view") || "products";
    if (view === "orders") {
      const q = await db.query(`SELECT o.*,COALESCE(NULLIF(p.display_name,''),p.referral_code,o.marketer_id) AS marketer_name,
        p.referral_code,p.phone AS marketer_phone,p.email AS marketer_email
        FROM solo_marketing_orders o
        LEFT JOIN app_profiles p ON p.id=o.marketer_id
        WHERE o.deleted_at IS NULL
        ORDER BY o.created_at DESC LIMIT 1000`);
      return res.json({ok:true,orders:q.rows,statuses});
    }
    const [products,rates] = await Promise.all([
      db.query("SELECT * FROM solo_marketing_products ORDER BY created_at DESC"),
      db.query("SELECT governorate,fee,active,updated_at FROM solo_marketing_shipping_rates ORDER BY governorate")
    ]);
    const rows = await Promise.all(products.rows.map(async p=>({...p,image_url:p.image_key?await storage.url(p.image_key):null})));
    return res.json({ok:true,products:rows,shipping_rates:rates.rows,statuses});
  }
  if (req.method !== "POST") return res.status(405).json({error:"method_not_allowed"});
  const b = parseBody(req);
  const action = clean(b.action);
  try {
    if (action === "create_product" || action === "update_product") {
      const id = clean(b.product_id);
      const name = clean(b.name).slice(0,180);
      const short = clean(b.short_description).slice(0,500);
      const description = clean(b.description).slice(0,12000);
      const base = Number(b.base_price), start = Number(b.starting_price);
      const min = Number(b.min_price), max = Number(b.max_price);
      const stock = Number(b.stock);
      const type = b.product_type === "clothing" ? "clothing" : "general";
      const sizes = type === "clothing" ? parseList(b.sizes) : [];
      const colors = type === "clothing" ? parseList(b.colors) : [];
      if (!name) return res.status(400).json({error:"name_required"});
      if (![base,start,min,max,stock].every(Number.isFinite) || base<0 || min<base || max<min || start<min || start>max || stock<0 || !Number.isInteger(stock)) {
        return res.status(400).json({error:"invalid_product_prices_or_stock"});
      }
      if (type === "clothing" && (!sizes.length || !colors.length)) return res.status(400).json({error:"clothing_sizes_and_colors_required"});
      if (action === "create_product") {
        const q = await db.query(`INSERT INTO solo_marketing_products
          (name,short_description,description,base_price,starting_price,min_price,max_price,stock,product_type,sizes,colors,active)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12)
          RETURNING *`,[name,short,description,base,start,min,max,stock,type,JSON.stringify(sizes),JSON.stringify(colors),b.active!==false]);
        return res.status(201).json({ok:true,product:q.rows[0]});
      }
      if (!id) return res.status(400).json({error:"product_id_required"});
      const q = await db.query(`UPDATE solo_marketing_products SET
          name=$1,short_description=$2,description=$3,base_price=$4,starting_price=$5,min_price=$6,max_price=$7,
          stock=$8,product_type=$9,sizes=$10::jsonb,colors=$11::jsonb,active=$12,updated_at=now()
        WHERE id=$13 RETURNING *`,[name,short,description,base,start,min,max,stock,type,JSON.stringify(sizes),JSON.stringify(colors),b.active!==false,id]);
      if (!q.rows.length) return res.status(404).json({error:"product_not_found"});
      return res.json({ok:true,product:q.rows[0]});
    }
    if (action === "upload_image") {
      const productId = clean(b.product_id);
      const file = (req.files||[]).find(f=>f.field==="file");
      if (!productId || !file) return res.status(400).json({error:"product_and_file_required"});
      if (!["image/jpeg","image/png","image/webp"].includes(file.contentType)) return res.status(415).json({error:"image_type_not_supported"});
      if (!file.buffer || file.buffer.length > 8*1024*1024) return res.status(413).json({error:"image_too_large"});
      const found = await db.query("SELECT id,image_key FROM solo_marketing_products WHERE id=$1",[productId]);
      if (!found.rows.length) return res.status(404).json({error:"product_not_found"});
      const ext = (clean(file.filename).split(".").pop()||"jpg").toLowerCase().replace(/[^a-z0-9]/g,"") || "jpg";
      const key = "solo-marketing/products/"+productId+"/"+crypto.randomUUID()+"."+ext;
      await storage.put(key,file.buffer,file.contentType);
      await db.query("UPDATE solo_marketing_products SET image_key=$1,updated_at=now() WHERE id=$2",[key,productId]);
      if (found.rows[0].image_key) { try { await storage.del(found.rows[0].image_key); } catch {} }
      return res.json({ok:true,image_url:await storage.url(key)});
    }
    if (action === "toggle_product") {
      const q=await db.query("UPDATE solo_marketing_products SET active=NOT active,updated_at=now() WHERE id=$1 RETURNING id,active",[clean(b.product_id)]);
      if(!q.rows.length)return res.status(404).json({error:"product_not_found"});
      return res.json({ok:true,product:q.rows[0]});
    }
    if (action === "delete_product") {
      const q=await db.query("UPDATE solo_marketing_products SET active=false,updated_at=now() WHERE id=$1 RETURNING id",[clean(b.product_id)]);
      if(!q.rows.length)return res.status(404).json({error:"product_not_found"});
      return res.json({ok:true});
    }
    if (action === "update_shipping") {
      const governorate=clean(b.governorate),fee=Number(b.fee),active=b.active===true;
      if(!governorate||!Number.isFinite(fee)||fee<0)return res.status(400).json({error:"invalid_shipping_rate"});
      const q=await db.query(`INSERT INTO solo_marketing_shipping_rates(governorate,fee,active,updated_at)
        VALUES($1,$2,$3,now()) ON CONFLICT(governorate)
        DO UPDATE SET fee=EXCLUDED.fee,active=EXCLUDED.active,updated_at=now()
        RETURNING governorate,fee,active`,[governorate,fee,active]);
      return res.json({ok:true,shipping_rate:q.rows[0]});
    }
    if (action === "update_order_status") {
      const orderId=clean(b.order_id),status=clean(b.status);
      if(!orderId||!statuses.includes(status))return res.status(400).json({error:"invalid_order_status"});
      const q=await db.query("UPDATE solo_marketing_orders SET status=$1,updated_at=now() WHERE id=$2 AND deleted_at IS NULL RETURNING id,order_code,status,commission,commission_credited_at",[status,orderId]);
      if(!q.rows.length)return res.status(404).json({error:"order_not_found"});
      return res.json({ok:true,order:q.rows[0]});
    }
    if (action === "confirm_order") {
      const orderId=clean(b.order_id);
      if(!orderId)return res.status(400).json({error:"order_id_required"});
      const q=await db.query("SELECT confirm_solo_marketing_order($1) AS result",[orderId]);
      return res.json({ok:true,result:q.rows[0]?.result||{}});
    }
    if (action === "delete_order") {
      const orderId=clean(b.order_id);
      if(!orderId)return res.status(400).json({error:"order_id_required"});
      const q=await db.query("SELECT delete_solo_marketing_order($1) AS deleted",[orderId]);
      if(q.rows[0]?.deleted!==true)return res.status(404).json({error:"order_not_found"});
      return res.json({ok:true});
    }
    return res.status(400).json({error:"unknown_action"});
  } catch(error) {
    const message=String(error?.message||"operation_failed").slice(0,180);
    return res.status(400).json({error:message});
  }
}