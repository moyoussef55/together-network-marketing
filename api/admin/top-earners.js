import { db } from "hatchable";
import { requireAdminSession } from "../../lib/admin-auth.js";

export const access = "public";
export const methods = ["GET"];

export default async function handler(req, res) {
  if (!(await requireAdminSession(req, res))) return;
  try {
    const result = await db.query(`
      WITH earnings AS (
        SELECT marketer_id, amount::numeric AS amount, 0::numeric AS direct_amount,
               amount::numeric AS network_amount, 0::numeric AS check_amount
          FROM commission_ledger
        UNION ALL
        SELECT marketer_id, amount::numeric, amount::numeric, 0::numeric, 0::numeric
          FROM network_direct_commissions
        UNION ALL
        SELECT member_id, check_amount::numeric, 0::numeric, 0::numeric, check_amount::numeric
          FROM network_bv_settlements
         WHERE check_amount > 0
      )
      SELECT p.id, p.referral_code,
             COALESCE(NULLIF(p.display_name,''), NULLIF(concat_ws(' ',p.first_name,p.second_name,p.third_name,p.fourth_name),''), p.referral_code, 'مسوق') AS name,
             SUM(e.amount)::numeric AS total_earnings,
             SUM(e.direct_amount)::numeric AS direct_earnings,
             SUM(e.network_amount)::numeric AS network_earnings,
             SUM(e.check_amount)::numeric AS weekly_checks
        FROM earnings e
        JOIN app_profiles p ON p.id=e.marketer_id
       WHERE p.role='marketer' AND p.deleted_at IS NULL
       GROUP BY p.id,p.referral_code,p.display_name,p.first_name,p.second_name,p.third_name,p.fourth_name
       HAVING SUM(e.amount)>0
       ORDER BY SUM(e.amount) DESC, name ASC
    `);
    return res.json({ ok:true, rows:result.rows.map(r=>({
      id:r.id, referral_code:r.referral_code, name:r.name,
      total_earnings:Number(r.total_earnings||0),
      direct_earnings:Number(r.direct_earnings||0),
      network_earnings:Number(r.network_earnings||0),
      weekly_checks:Number(r.weekly_checks||0)
    })) });
  } catch (error) {
    return res.status(500).json({ ok:false, error:"top_earners_unavailable" });
  }
}