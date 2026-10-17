import { db } from "hatchable";
import { requireAdminSession } from "../../lib/admin-auth.js";
export const access = "public";
export const methods = ["GET"];

export default async function(req,res) { if(!(await requireAdminSession(req,res)))return;
  if(req.method!=="GET") return res.status(405).json({ok:false,error:"method_not_allowed"});
  const q=String(req.query?.q||"").trim();
  const status=String(req.query?.status||"all").trim().toLowerCase();
  const params=[];
  const where=[];
  if(status!=="all") {
    if(status==="pending") where.push("lower(w.status) IN ('pending','قيد الانتظار','under_review')");
    else if(status==="completed") where.push("lower(w.status) IN ('completed','complete','paid','approved','done')");
    else if(status==="cancelled") where.push("lower(w.status) IN ('cancelled','canceled','rejected','declined','مرفوض','ملغى','ملغي')");
  }
  if(q) {
    params.push("%"+q+"%");
    const n=params.length;
    where.push("(COALESCE(w.full_name,'') ILIKE $"+n+" OR COALESCE(w.transfer_phone,'') ILIKE $"+n+" OR COALESCE(a.display_name,'') ILIKE $"+n+" OR COALESCE(a.email,'') ILIKE $"+n+" OR COALESCE(a.phone,'') ILIKE $"+n+" OR COALESCE(a.referral_code,'') ILIKE $"+n+" OR w.id::text ILIKE $"+n+" OR w.user_id ILIKE $"+n+")");
  }
  const sqlWhere=where.length?"WHERE "+where.join(" AND "):"";
  const rows=await db.query(`SELECT w.id,w.user_id,w.amount,w.status,w.note,w.full_name,w.transfer_phone,w.created_at,
      a.display_name,a.email,a.phone AS marketer_phone,a.referral_code,a.status AS marketer_status
    FROM withdrawal_requests w
    LEFT JOIN app_profiles a ON a.id=w.user_id
    ${sqlWhere}
    ORDER BY CASE WHEN lower(w.status) IN ('pending','قيد الانتظار','under_review') THEN 0 ELSE 1 END,w.created_at DESC
    LIMIT 500`,params);
  const stats=await db.query(`SELECT
    COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE lower(status) IN ('pending','قيد الانتظار','under_review'))::int AS pending,
    COUNT(*) FILTER (WHERE lower(status) IN ('completed','complete','paid','approved','done'))::int AS completed,
    COUNT(*) FILTER (WHERE lower(status) IN ('cancelled','canceled','rejected','declined','مرفوض','ملغى','ملغي'))::int AS cancelled
    FROM withdrawal_requests`);
  return res.json({ok:true,requests:rows.rows.map(x=>({...x,amount:Number(x.amount||0)})),stats:stats.rows[0]||{total:0,pending:0,completed:0,cancelled:0}});
}