import { db } from "hatchable";
import { requireAdminSession } from "../../lib/admin-auth.js";

export const access = "public";
export const methods = ["GET"];

const clean = v => String(v ?? "").trim().slice(0, 160);
const parseArray = v => {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") { try { const parsed = JSON.parse(v); return Array.isArray(parsed) ? parsed : []; } catch {} }
  return [];
};
const nameOf = p => p?.marketer_name || p?.display_name || p?.name || p?.referral_code || p?.marketer_id || "مسوق";

async function withdrawalReport(q) {
  const result = await db.query("SELECT list_network_withdrawals_admin() AS requests");
  const all = parseArray(result.rows[0]?.requests);
  const needle = q.toLocaleLowerCase("ar");
  const matches = x => !needle || [
    x.full_name, x.display_name, x.name, x.email, x.marketer_phone, x.transfer_phone,
    x.referral_code, x.id, x.user_id
  ].some(v => String(v || "").toLocaleLowerCase("ar").includes(needle));
  const rows = all.filter(matches).map(x => ({
    ...x,
    marketer_name: nameOf(x),
    amount: Number(x.amount || 0),
    created_at: x.created_at || null
  }));
  return { ok: true, action: "withdrawals", query: q, total: rows.length, rows };
}

async function orderRows(q) {
  const result = await db.query(`
    SELECT
      o.id::text AS id,
      o.marketer_id::text AS marketer_id,
      o.total::numeric AS total,
      o.created_at,
      o.status AS order_status,
      o.fulfillment_status,
      o.shipping_country,
      o.shipping_governorate,
      o.shipping_address,
      o.shipping_phone,
      o.payment_method,
      COALESCE(NULLIF(p.display_name,''), NULLIF(concat_ws(' ',p.first_name,p.second_name,p.third_name,p.fourth_name),''), p.referral_code, o.marketer_id::text, 'مسوق') AS marketer_name,
      p.referral_code,
      p.email AS marketer_email,
      p.phone AS marketer_phone,
      COALESCE(
        json_agg(json_build_object(
          'product_id',oi.product_id::text,
          'name',pr.name,
          'quantity',oi.quantity,
          'unit_price',oi.unit_price,
          'line_total',(oi.quantity * oi.unit_price),
          'bv',oi.bv,
          'selected_size',oi.selected_size,
          'selected_color',oi.selected_color
        ) ORDER BY oi.id) FILTER (WHERE oi.id IS NOT NULL),
        '[]'::json
      ) AS items
    FROM orders o
    LEFT JOIN app_profiles p ON p.id::text=o.marketer_id::text
    LEFT JOIN order_items oi ON oi.order_id=o.id
    LEFT JOIN products pr ON pr.id=oi.product_id
    WHERE NULLIF($1,'') IS NULL OR
      COALESCE(p.display_name,'') ILIKE '%'||$1||'%' OR
      COALESCE(concat_ws(' ',p.first_name,p.second_name,p.third_name,p.fourth_name),'') ILIKE '%'||$1||'%' OR
      COALESCE(p.referral_code,'') ILIKE '%'||$1||'%' OR
      COALESCE(o.marketer_id::text,'') ILIKE '%'||$1||'%' OR
      o.id::text ILIKE '%'||$1||'%' OR
      EXISTS (
        SELECT 1 FROM order_items si
        JOIN products sp ON sp.id=si.product_id
        WHERE si.order_id=o.id AND COALESCE(sp.name,'') ILIKE '%'||$1||'%'
      )
    GROUP BY o.id,p.display_name,p.first_name,p.second_name,p.third_name,p.fourth_name,p.referral_code,p.email,p.phone
    ORDER BY o.created_at DESC
    LIMIT 1000
  `, [q]);
  return result.rows.map(o => ({
    ...o,
    total: Number(o.total || 0),
    items: parseArray(o.items).map(i => ({
      ...i, quantity: Number(i.quantity || 0), unit_price: Number(i.unit_price || 0),
      line_total: Number(i.line_total ?? (Number(i.quantity || 0) * Number(i.unit_price || 0))),
      bv: Number(i.bv || 0)
    }))
  }));
}

async function productReport(q) {
  const orders = await orderRows(q);
  const rows = orders.flatMap(o => o.items.map((item, index) => ({
    id: o.id + ":" + String(item.product_id || index) + ":" + index,
    order_id: o.id,
    marketer_id: o.marketer_id,
    marketer_name: o.marketer_name,
    referral_code: o.referral_code,
    created_at: o.created_at,
    order_status: o.order_status,
    fulfillment_status: o.fulfillment_status,
    product_id: item.product_id,
    product_name: item.name || "منتج",
    quantity: item.quantity,
    unit_price: item.unit_price,
    line_total: item.line_total,
    bv: item.bv,
    selected_size: item.selected_size,
    selected_color: item.selected_color,
    total: o.total,
    shipping_phone: o.shipping_phone
  })));
  return { ok: true, action: "products", query: q, total: rows.length, rows };
}

async function invoiceReport(q) {
  const rows = await orderRows(q);
  return { ok: true, action: "invoices", query: q, total: rows.length, rows };
}

export default async function handler(req, res) {
  if (!(await requireAdminSession(req, res))) return;
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "method_not_allowed" });
  const action = clean(req.query?.action || "");
  const q = clean(req.query?.q || "");
  try {
    if (action === "withdrawals") return res.json(await withdrawalReport(q));
    if (action === "products") return res.json(await productReport(q));
    if (action === "invoices") return res.json(await invoiceReport(q));
    return res.status(400).json({ ok: false, error: "invalid_action" });
  } catch (error) {
    console.error("admin_reports_failed", action, error);
    return res.status(500).json({ ok: false, error: "تعذر تحميل التقرير المطلوب." });
  }
}