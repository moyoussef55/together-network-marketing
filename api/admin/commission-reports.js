import { db } from "hatchable";
import { requireAdminSession } from "../../lib/admin-auth.js";

export const access = "public";
export const methods = ["GET"];

export default async function handler(req, res) {
  if (!(await requireAdminSession(req, res))) return;
  const action = String(req.query?.action || "checks");
  const q = String(req.query?.q || "").trim().slice(0, 160);
  const page = Math.max(1, Math.min(100000, Number.parseInt(req.query?.page || "1", 10) || 1));
  const limit = 20;
  const offset = (page - 1) * limit;

  if (action === "checks") {
    let picked = String(req.query?.date || "").trim();
    if (!picked) {
      const latest = await db.query(`SELECT MAX(s.week_end)::date AS latest_week_end FROM network_bv_settlements s WHERE s.check_amount > 0`);
      picked = String(latest.rows[0]?.latest_week_end || "").slice(0, 10);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(picked)) {
      return res.status(400).json({ ok:false, error:"اختار تاريخ الأسبوع أولاً." });
    }
    const params = [picked];
    let search = "";
    if (q) {
      params.push("%" + q.toLowerCase() + "%");
      search = " AND (lower(COALESCE(p.display_name,'')) LIKE $2 OR lower(COALESCE(p.referral_code,'')) LIKE $2 OR lower(p.id) LIKE $2)";
    }
    const count = await db.query(`
      SELECT count(*)::int AS total FROM (
        SELECT s.member_id
          FROM network_bv_settlements s
          JOIN app_profiles p ON p.id=s.member_id
         WHERE s.check_amount > 0 AND $1::date BETWEEN s.week_start AND s.week_end
           AND p.deleted_at IS NULL ${search}
         GROUP BY s.member_id
        HAVING sum(s.check_amount) > 0
      ) x
    `, params);
    const rows = await db.query(`
      SELECT p.id, p.referral_code, COALESCE(NULLIF(p.display_name,''),concat_ws(' ',p.first_name,p.second_name,p.third_name,p.fourth_name),'مسوق') AS name,
             sum(s.check_amount)::numeric AS check_amount,
             floor(sum(s.check_amount)/1500)::int AS check_count,
             count(*) FILTER (WHERE s.check_amount>0)::int AS settlement_count,
             sum(s.right_bv)::numeric AS bv_right_before, sum(s.left_bv)::numeric AS bv_left_before,
             sum(s.carry_right)::numeric AS bv_right_after, sum(s.carry_left)::numeric AS bv_left_after,
             min(s.week_start)::date AS week_start, max(s.week_end)::date AS week_end,
             string_agg(DISTINCT s.account_position::text, ', ' ORDER BY s.account_position::text) AS positions
        FROM network_bv_settlements s
        JOIN app_profiles p ON p.id=s.member_id
       WHERE s.check_amount > 0 AND $1::date BETWEEN s.week_start AND s.week_end
         AND p.deleted_at IS NULL ${search}
       GROUP BY p.id,p.referral_code,p.display_name,p.first_name,p.second_name,p.third_name,p.fourth_name
      HAVING sum(s.check_amount)>0
       ORDER BY sum(s.check_amount) DESC, name ASC
       LIMIT ${limit} OFFSET ${offset}
    `, params);
    return res.json({ok:true, action, date:picked, total:Number(count.rows[0]?.total||0), page, page_size:limit, pages:Math.ceil(Number(count.rows[0]?.total||0)/limit), rows:rows.rows});
  }

  if (action === "commissions") {
    const params = [];
    let search = "";
    if (q) {
      params.push("%" + q.toLowerCase() + "%");
      search = " WHERE lower(COALESCE(p.display_name,'')) LIKE $1 OR lower(COALESCE(p.referral_code,'')) LIKE $1 OR lower(p.id) LIKE $1";
    }
    const base = `
      WITH all_commissions AS (
        SELECT marketer_id, amount, created_at, 'عمولة شبكة'::text AS kind, order_id::text AS ref FROM commission_ledger
        UNION ALL
        SELECT marketer_id, amount, COALESCE(paid_at,created_at), 'عمولة مباشرة'::text, order_id::text FROM network_direct_commissions
      ), grouped AS (
        SELECT p.id,p.referral_code,
               COALESCE(NULLIF(p.display_name,''),concat_ws(' ',p.first_name,p.second_name,p.third_name,p.fourth_name),'مسوق') AS name,
               sum(c.amount)::numeric AS total_amount, count(*)::int AS commission_count,
               max(c.created_at) AS latest_at,
               json_agg(json_build_object('date',c.created_at,'amount',c.amount,'kind',c.kind,'reference',c.ref) ORDER BY c.created_at DESC) AS history
          FROM all_commissions c JOIN app_profiles p ON p.id=c.marketer_id
         WHERE p.deleted_at IS NULL
         GROUP BY p.id,p.referral_code,p.display_name,p.first_name,p.second_name,p.third_name,p.fourth_name
      )
      SELECT * FROM grouped ${search}
    `;
    const count = await db.query(`SELECT count(*)::int AS total FROM (${base}) x`, params);
    const rows = await db.query(`${base} ORDER BY latest_at DESC NULLS LAST, name ASC LIMIT ${limit} OFFSET ${offset}`, params);
    return res.json({ok:true, action, date:picked, total:Number(count.rows[0]?.total||0), page, page_size:limit, pages:Math.ceil(Number(count.rows[0]?.total||0)/limit), rows:rows.rows});
  }

  if (action === "trace") {
    if (!q) return res.json({ok:true, action, query:"", total:0, rows:[]});
    const rows = await db.query(`
      SELECT dc.id AS commission_id, dc.amount, dc.status, COALESCE(dc.paid_at,dc.created_at) AS commission_date,
             dc.order_id::text AS order_id,
             recipient.id AS recipient_id, recipient.referral_code AS recipient_code,
             COALESCE(NULLIF(recipient.display_name,''),concat_ws(' ',recipient.first_name,recipient.second_name,recipient.third_name,recipient.fourth_name),'مسوق') AS recipient_name,
             buyer.id AS buyer_id, buyer.referral_code AS buyer_code,
             COALESCE(NULLIF(buyer.display_name,''),concat_ws(' ',buyer.first_name,buyer.second_name,buyer.third_name,buyer.fourth_name),'مسوق') AS buyer_name
        FROM network_direct_commissions dc
        JOIN app_profiles recipient ON recipient.id=dc.marketer_id
        LEFT JOIN orders o ON o.id=dc.order_id
        LEFT JOIN app_profiles buyer ON buyer.id=o.marketer_id
       WHERE lower(dc.order_id::text)=lower($1)
          OR lower(COALESCE(buyer.id,''))=lower($1)
          OR lower(COALESCE(buyer.referral_code,''))=lower($1)
          OR lower(COALESCE(recipient.id,''))=lower($1)
          OR lower(COALESCE(recipient.referral_code,''))=lower($1)
          OR lower(COALESCE(buyer.id,'')) LIKE '%'||lower($1)||'%'
          OR lower(COALESCE(buyer.referral_code,'')) LIKE '%'||lower($1)||'%'
       ORDER BY COALESCE(dc.paid_at,dc.created_at) DESC LIMIT 100
    `, [q]);
    return res.json({ok:true, action, query:q, total:rows.rows.length, rows:rows.rows});
  }

  return res.status(400).json({ok:false,error:"invalid_action"});
}