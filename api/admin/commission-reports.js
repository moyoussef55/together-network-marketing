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

  if (action === "update_runs") {
    const runs = await db.query(`
      SELECT r.id,r.update_at,r.update_type,r.week_start,r.week_end,
             r.allocated_rows,r.accounts_count,r.check_rows,r.check_rate,
             r.direct_commissions_released,r.cheque_marketers,
             r.total_cheque_amount,r.report_rows,
             COALESCE(s.unique_marketers,0)::int AS unique_marketers,
             COALESCE(s.actual_cheque_marketers,0)::int AS actual_cheque_marketers,
             COALESCE(s.cheque_count,0)::int AS cheque_count,
             COALESCE(s.actual_total_amount,0)::numeric AS actual_total_amount,
             (SELECT COALESCE(json_agg(a ORDER BY a.account_position),'[]'::json) FROM (
                SELECT rr.account_position,
                       COUNT(DISTINCT rr.member_id) FILTER (WHERE rr.check_amount>0)::int AS marketers_with_cheques,
                       COUNT(*) FILTER (WHERE rr.check_amount>0)::int AS cheque_rows,
                       FLOOR(COALESCE(SUM(rr.check_amount),0)/1500)::int AS cheque_count,
                       COALESCE(SUM(rr.check_amount),0)::numeric AS total_cheque_amount
                  FROM network_bv_update_report_rows rr
                 WHERE rr.update_run_id=r.id
                 GROUP BY rr.account_position
             ) a) AS agency_totals
        FROM network_bv_update_runs r
        LEFT JOIN LATERAL (
          SELECT COUNT(DISTINCT rr.member_id)::int AS unique_marketers,
                 COUNT(DISTINCT rr.member_id) FILTER (WHERE rr.check_amount > 0)::int AS actual_cheque_marketers,
                 FLOOR(COALESCE(SUM(rr.check_amount),0)/1500)::int AS cheque_count,
                 COALESCE(SUM(rr.check_amount),0)::numeric AS actual_total_amount
            FROM network_bv_update_report_rows rr
           WHERE rr.update_run_id=r.id
        ) s ON TRUE
       ORDER BY r.update_at DESC
       LIMIT 100
    `);
    return res.json({ok:true,action,runs:runs.rows});
  }

  if (action === "update_report") {
    const runId = String(req.query?.run_id || "").trim();
    if (!runId) return res.status(400).json({ok:false,error:"missing_update_run"});
    const runResult = await db.query(`
      SELECT id,update_at,update_type,week_start,week_end,allocated_rows,
             accounts_count,check_rows,check_rate,direct_commissions_released,
             cheque_marketers,total_cheque_amount,report_rows
        FROM network_bv_update_runs
       WHERE id::text=$1
       LIMIT 1
    `, [runId]);
    if (!runResult.rows.length) return res.status(404).json({ok:false,error:"update_report_not_found"});

    const summaryResult = await db.query(`
      SELECT COUNT(DISTINCT rr.member_id)::int AS unique_marketers,
             COUNT(DISTINCT rr.member_id) FILTER (WHERE rr.check_amount > 0)::int AS cheque_marketers,
             FLOOR(COALESCE(SUM(rr.check_amount),0)/1500)::int AS cheque_count,
             COALESCE(SUM(rr.check_amount),0)::numeric AS total_cheque_amount
        FROM network_bv_update_report_rows rr
       WHERE rr.update_run_id=$1
    `, [runId]);

    const agenciesResult = await db.query(`
      SELECT rr.account_position,
             COUNT(DISTINCT rr.member_id)::int AS marketers_in_agency,
             COUNT(DISTINCT rr.member_id) FILTER (WHERE rr.check_amount > 0)::int AS marketers_with_cheques,
             COUNT(*) FILTER (WHERE rr.check_amount > 0)::int AS cheque_rows,
             FLOOR(COALESCE(SUM(rr.check_amount),0)/1500)::int AS cheque_count,
             COALESCE(SUM(rr.check_amount),0)::numeric AS total_cheque_amount
        FROM network_bv_update_report_rows rr
       WHERE rr.update_run_id=$1
       GROUP BY rr.account_position
       ORDER BY rr.account_position
    `, [runId]);

    const params = [runId];
    let search = "";
    if (q) {
      params.push("%" + q.toLowerCase() + "%");
      search = " AND (lower(COALESCE(p.display_name,'')) LIKE $2 OR lower(COALESCE(p.referral_code,'')) LIKE $2 OR lower(p.id::text) LIKE $2)";
    }
    const base = `
      SELECT p.id,p.referral_code,
             COALESCE(NULLIF(p.display_name,''),concat_ws(' ',p.first_name,p.second_name,p.third_name,p.fourth_name),'مسوق') AS name,
             rr.account_position,
             SUM(rr.check_amount)::numeric AS check_amount,
             FLOOR(SUM(rr.check_amount)/1500)::int AS check_count,
             SUM(rr.right_bv_before)::numeric AS right_bv_before,
             SUM(rr.left_bv_before)::numeric AS left_bv_before,
             SUM(rr.matched_bv)::numeric AS matched_bv,
             SUM(rr.carry_right_after)::numeric AS carry_right_after,
             SUM(rr.carry_left_after)::numeric AS carry_left_after
        FROM network_bv_update_report_rows rr
        JOIN app_profiles p ON p.id::text=rr.member_id
       WHERE rr.update_run_id=$1 AND rr.check_amount > 0 AND p.deleted_at IS NULL ${search}
       GROUP BY p.id,p.referral_code,p.display_name,p.first_name,p.second_name,p.third_name,p.fourth_name,rr.account_position
    `;
    const count = await db.query("SELECT COUNT(*)::int AS total FROM (" + base + ") report_rows", params);
    const reportLimit = String(req.query?.all || "") === "1" ? 1000 : limit;
    const rows = await db.query("SELECT * FROM (" + base + ") report_rows ORDER BY account_position ASC,check_amount DESC,name ASC LIMIT " + reportLimit + " OFFSET " + (reportLimit===1000?0:offset), params);
    return res.json({
      ok:true,action,run:runResult.rows[0],summary:summaryResult.rows[0] || {},
      agency_summary:agenciesResult.rows,
      total:Number(count.rows[0]?.total||0),page,page_size:reportLimit,
      pages:Math.ceil(Number(count.rows[0]?.total||0)/reportLimit),rows:rows.rows
    });
  }

  if (action === "checks") {
    let picked = String(req.query?.date || "").trim();
    if (!picked) {
      const latest = await db.query(`SELECT MAX(s.week_end)::date AS latest_week_end FROM network_bv_settlements s WHERE s.check_amount > 0 AND s.settled_at <= now()`);
      picked = String(latest.rows[0]?.latest_week_end || "").slice(0, 10);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(picked)) {
      return res.status(400).json({ ok:false, error:"اختار تاريخ الأسبوع أولاً." });
    }
    const params = [picked];
    let search = "";
    if (q) {
      params.push("%" + q.toLowerCase() + "%");
      search = " AND (lower(COALESCE(p.display_name,'')) LIKE $2 OR lower(COALESCE(p.referral_code,'')) LIKE $2 OR lower(p.id::text) LIKE $2)";
    }
    const count = await db.query(`
      SELECT count(*)::int AS total FROM (
        SELECT s.member_id
          FROM network_bv_settlements s
          JOIN app_profiles p ON p.id=s.member_id
         WHERE s.check_amount > 0 AND s.settled_at <= now()
           AND $1::date BETWEEN s.week_start AND s.week_end
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
             json_agg(json_build_object(
               'account_position',s.account_position,
               'right_bv_before',s.right_bv,'left_bv_before',s.left_bv,
               'carry_right_after',s.carry_right,'carry_left_after',s.carry_left,
               'check_amount',s.check_amount,'settled_at',s.settled_at
             ) ORDER BY s.account_position) AS positions_detail,
             max(s.settled_at) AS update_at,
             min(s.week_start)::date AS week_start, max(s.week_end)::date AS week_end,
             string_agg(DISTINCT s.account_position::text, ', ' ORDER BY s.account_position::text) AS positions
        FROM network_bv_settlements s
        JOIN app_profiles p ON p.id=s.member_id
       WHERE s.check_amount > 0 AND s.settled_at <= now()
         AND $1::date BETWEEN s.week_start AND s.week_end
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
      search = " WHERE lower(COALESCE(p.display_name,'')) LIKE $1 OR lower(COALESCE(p.referral_code,'')) LIKE $1 OR lower(p.id::text) LIKE $1";
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
    return res.json({ok:true, action, total:Number(count.rows[0]?.total||0), page, page_size:limit, pages:Math.ceil(Number(count.rows[0]?.total||0)/limit), rows:rows.rows});
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
          OR lower(COALESCE(buyer.id::text,''))=lower($1)
          OR lower(COALESCE(buyer.referral_code,''))=lower($1)
          OR lower(COALESCE(recipient.id::text,''))=lower($1)
          OR lower(COALESCE(recipient.referral_code,''))=lower($1)
          OR lower(COALESCE(buyer.id::text,'')) LIKE '%'||lower($1)||'%'
          OR lower(COALESCE(buyer.referral_code,'')) LIKE '%'||lower($1)||'%'
       ORDER BY COALESCE(dc.paid_at,dc.created_at) DESC LIMIT 100
    `, [q]);
    return res.json({ok:true, action, query:q, total:rows.rows.length, rows:rows.rows});
  }

  return res.status(400).json({ok:false,error:"invalid_action"});
}