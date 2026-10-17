import { db, config } from "hatchable";
import { requireNetworkUser } from "../../lib/network-auth.js";

const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[ch]));
const money = value => Number(value || 0).toLocaleString("ar-EG", {maximumFractionDigits:2});
const invoiceFooter = "نشكركم على طلبكم من شركة توجيذر للتسويق الالكترونى. هذه فاتوره بالشراء وتفعيل حسابك يرجى العلم انه تم تفعيل حسابك بنجاح وتم خصم قيمة المنتج من حسابك واصبح لديك منتج سيتم ارساله لك عن طريق شركة الشحن ولا يحق لك استرجاع المنتج او استرداد المبلغ المدفوع ولكن يمكنك استبدال المنتج باي منتج اخر موجود على متجرك على موقع الشركه مع دفع الفرق فى موعد اقصاه شهر من تاريخ الشراء ولكن يلغى هذا البند في حالة انك استلمت المنتج لانه فى حالة استلام المنتج لا يتم الاستبدال. فريق دعم Together";

async function sendBvOrderInvoice(orderId, marketerId) {
  try {
    const head = await db.query(`SELECT o.id,o.total,o.created_at,o.fulfillment_status AS status,
      o.shipping_country,o.shipping_governorate,o.shipping_address,o.shipping_phone,
      p.email AS marketer_email,COALESCE(NULLIF(p.display_name,''),p.referral_code,'مسوق Together') AS marketer_name,
      p.referral_code,p.phone AS marketer_phone
      FROM orders o LEFT JOIN app_profiles p ON p.id=o.marketer_id
      WHERE o.id=$1 AND o.marketer_id=$2 LIMIT 1`, [orderId, marketerId]);
    if (!head.rows.length) return {sent:false, reason:"order_details_missing"};
    const order = head.rows[0];
    const itemsResult = await db.query(`SELECT oi.product_id,COALESCE(pr.name,'منتج') AS name,
      oi.quantity,oi.unit_price,oi.bv
      FROM order_items oi LEFT JOIN products pr ON pr.id=oi.product_id
      WHERE oi.order_id=$1 ORDER BY oi.id`, [orderId]);
    const items = itemsResult.rows || [];
    if (!items.some(item => Number(item.bv || 0) > 0)) return {sent:false, reason:"no_bv_items"};
    const to = String(order.marketer_email || "").trim();
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      console.warn("BV invoice email skipped: marketer email unavailable", String(orderId));
      return {sent:false, reason:"email_missing"};
    }
    const date = new Date(order.created_at).toLocaleString("ar-EG", {timeZone:"Africa/Cairo"});
    const rowsHtml = items.map(item => {
      const quantity = Number(item.quantity || 0);
      const price = Number(item.unit_price || 0);
      return "<tr><td style='padding:10px;border:1px solid #dbe2ea'>" + escapeHtml(item.name) +
        "</td><td style='padding:10px;border:1px solid #dbe2ea;text-align:center'>" + quantity +
        "</td><td style='padding:10px;border:1px solid #dbe2ea;text-align:center'>" + money(price) + " ج.م</td>" +
        "<td style='padding:10px;border:1px solid #dbe2ea;text-align:center'>" + money(price * quantity) + " ج.م</td></tr>";
    }).join("");
    const html = "<div dir='rtl' style='font-family:Arial,sans-serif;color:#182332;max-width:760px;margin:auto;line-height:1.8'>" +
      "<p>مرحبًا " + escapeHtml(order.marketer_name) + "،</p>" +
      "<div style='border:1px solid #dbe2ea;border-radius:12px;padding:20px'>" +
      "<h2 style='margin:0 0 4px'>Together Network</h2><h3 style='margin:0 0 16px'>فاتورة طلب منتجات</h3>" +
      "<p><b>رقم الطلب:</b> " + escapeHtml(order.id) + "<br><b>التاريخ:</b> " + escapeHtml(date) +
      "<br><b>حالة الطلب:</b> " + escapeHtml(order.status || "جارى معالجة الطلب") + "</p>" +
      "<h4>بيانات المسوق</h4><p><b>الاسم:</b> " + escapeHtml(order.marketer_name) +
      "<br><b>كود المسوق:</b> " + escapeHtml(order.referral_code || "—") +
      "<br><b>الهاتف:</b> " + escapeHtml(order.marketer_phone || order.shipping_phone || "—") +
      "<br><b>البريد الإلكتروني:</b> " + escapeHtml(to) + "</p>" +
      "<h4>عنوان الشحن</h4><p>" + escapeHtml([order.shipping_country,order.shipping_governorate,order.shipping_address].filter(Boolean).join("، ")) +
      "<br>هاتف الشحن: " + escapeHtml(order.shipping_phone || "—") + "</p>" +
      "<table style='width:100%;border-collapse:collapse'><thead><tr style='background:#f1f5f9'>" +
      "<th style='padding:10px;border:1px solid #dbe2ea'>المنتج</th><th style='padding:10px;border:1px solid #dbe2ea'>الكمية</th>" +
      "<th style='padding:10px;border:1px solid #dbe2ea'>سعر الوحدة</th><th style='padding:10px;border:1px solid #dbe2ea'>الإجمالي</th></tr></thead><tbody>" +
      rowsHtml + "</tbody></table><h3 style='text-align:left'>الإجمالي: " + money(order.total) + " ج.م</h3></div>" +
      "<p style='margin-top:22px'>" + escapeHtml(invoiceFooter) + "</p></div>";
    const textItems = items.map(item => "- " + item.name + " | الكمية: " + item.quantity + " | سعر الوحدة: " + money(item.unit_price) + " ج.م | BV: " + item.bv).join("\\n");
    const textBody = "مرحبًا " + order.marketer_name + "،\\n\\nفاتورة طلب منتجات Together Network\\nرقم الطلب: " + order.id +
      "\\nالتاريخ: " + date + "\\nالمنتجات:\\n" + textItems + "\\nالإجمالي: " + money(order.total) +
      " ج.م\\n\\n" + invoiceFooter;
    const webAppUrl = String((await config.get("TOGETHER_GMAIL_WEBAPP_URL")) || "").trim();
    const sharedSecret = String((await config.get("TOGETHER_GMAIL_SHARED_SECRET")) || "").trim();
    if (!webAppUrl || !webAppUrl.startsWith("https://script.google.com/macros/s/") || !webAppUrl.endsWith("/exec")) {
      throw new Error("gmail_sender_not_configured_webapp_url");
    }
    if (!sharedSecret) throw new Error("gmail_sender_not_configured_shared_secret");
    const subject = "فاتورة شراء منتجات Together — الطلب " + String(order.id);
    const response = await fetch(webAppUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({token:sharedSecret,to,subject,html,text:textBody,attachments:[],attachments_required:false}),
      redirect: "follow"
    });
    const responseText = await response.text();
    let result;
    try { result = JSON.parse(responseText); }
    catch { throw new Error("gmail_sender_invalid_response_http_" + response.status); }
    if (!response.ok || result?.success !== true) {
      throw new Error("gmail_sender_failed_" + String(result?.error || ("http_" + response.status)).slice(0,250));
    }
    console.log("BV invoice email sent through Gmail web app", String(order.id), to);
    return {sent:true, provider:"google_apps_script"};
  } catch (error) {
    console.error("BV invoice email failed", String(orderId), String(error?.message || error));
    return {sent:false, reason:"send_failed"};
  }
}

export const access="public";
export const methods=["GET","POST"];

export default async function(req,res){
  const user=await requireNetworkUser(req,res);
  if(!user)return;
  const uid=String(user.id);
  const profile=await db.query("SELECT role,deleted_at,login_blocked FROM app_profiles WHERE id=$1",[uid]);
  if(!profile.rows.length||profile.rows[0].role!=="marketer"||profile.rows[0].deleted_at||profile.rows[0].login_blocked)return res.status(403).json({error:"marketer_only"});

  if(req.method==="GET"){
    const r=await db.query(`SELECT o.id,o.fulfillment_status AS status,o.total,o.created_at,o.shipping_country,o.shipping_governorate,o.shipping_address,o.shipping_phone,
      COALESCE(json_agg(json_build_object('product_id',oi.product_id,'name',p.name,'quantity',oi.quantity,'unit_price',oi.unit_price,'bv',oi.bv) ORDER BY oi.id) FILTER(WHERE oi.id IS NOT NULL),'[]') items
      FROM orders o LEFT JOIN order_items oi ON oi.order_id=o.id LEFT JOIN products p ON p.id=oi.product_id
      WHERE o.marketer_id=$1 GROUP BY o.id ORDER BY o.created_at DESC LIMIT 50`,[uid]);
    const w=await db.query("SELECT balance FROM wallets WHERE user_id=$1",[uid]);
    return res.json({ok:true,orders:r.rows,wallet_balance:Number(w.rows[0]?.balance||0)});
  }

  const b=typeof req.body==="string"?JSON.parse(req.body||"{}"):(req.body||{});
  const country=String(b.country||"").trim(),governorate=String(b.governorate||"").trim(),address=String(b.address||"").trim(),phone=String(b.phone||"").trim();
  if(!country||!governorate||!address||!phone)return res.status(400).json({error:"shipping_details_required"});
  const items=Array.isArray(b.items)?b.items:(b.product_id?[{product_id:b.product_id,quantity:1}]:[]);
  if(items.some(x=>!x||!/^[0-9a-f-]{36}$/i.test(String(x.product_id||""))||!Number.isInteger(Number(x.quantity??1))||Number(x.quantity??1)<1||Number(x.quantity??1)>99))return res.status(400).json({error:"invalid_cart_item"});
  const normalized=items.map(x=>({product_id:String(x.product_id).trim(),quantity:Number(x.quantity??1)}));
  if(!normalized.length)return res.status(400).json({error:"cart_empty"});
  const merged=[];
  for(const x of normalized){const old=merged.find(y=>y.product_id===x.product_id);if(old)old.quantity=Math.min(99,old.quantity+x.quantity);else merged.push({...x});}

  // Keep wallet reconciliation, debit, stock, order and transaction writes inside
  // one database function so the custom marketer session's RLS context is retained.
  const checkout=await db.query(
    "SELECT checkout_store_order($1,$2::jsonb,$3,$4,$5,$6) AS result",
    [uid,JSON.stringify(merged),country,governorate,address,phone]
  );
  let row=checkout.rows[0]?.result||{};
  if(typeof row==="string"){try{row=JSON.parse(row);}catch{row={};}}
  if(!row.order_data){
    const balance=Number(row.balance||0);
    const required=Number(row.required||0);
    if(Number(row.found||0)!==Number(row.requested||0))return res.status(404).json({error:"product_not_found",balance});
    if(row.valid===false)return res.status(409).json({error:"out_of_stock",balance});
    if(balance<required)return res.status(409).json({error:"insufficient_balance",balance,required});
    return res.status(409).json({error:"order_failed",balance});
  }
  // Record the sponsor's direct commission as pending after the qualifying purchase.
  // The weekly/manual update releases it to the wallet; the database function is idempotent.
  await db.query("SELECT credit_direct_commission_for_order($1::uuid) AS credited",[row.order_data.id]);
  // Email a separate invoice for any successful order containing one or more BV-valued items.
  // Email delivery errors must never undo a completed checkout or wallet debit.
  const invoiceEmail = await sendBvOrderInvoice(row.order_data.id, uid);
  const totalBv=Number(row.total_bv||0);
  const purchaseTier=totalBv>=3000?3:totalBv>=2000?2:totalBv>=1000?1:0;
  return res.status(201).json({ok:true,order:row.order_data,amount:Number(row.order_data.total),balance_after:Number(row.balance_after),total_bv:totalBv,purchase_tier:purchaseTier,invoice_email_sent:invoiceEmail.sent,message:"تم خصم قيمة الطلب من رصيدك وتسجيل الشراء بنجاح."});
}