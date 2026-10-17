import { db } from "hatchable";
import { requireAdminSession } from "../../lib/admin-auth.js";
export const access = "public";
export const methods = ["GET"];
export default async function(req,res){if(!(await requireAdminSession(req,res)))return;
 const [m,o,k]=await Promise.all([
  db.query("SELECT count(*)::int AS n FROM app_profiles WHERE role='marketer' AND deleted_at IS NULL"),
  db.query("SELECT count(*)::int AS n FROM orders"),
  db.query("SELECT COALESCE(SUM(floor(total_amount/1500)),0)::int AS n FROM (SELECT member_id,week_start,week_end,SUM(check_amount)::numeric AS total_amount FROM network_bv_settlements WHERE check_amount>0 GROUP BY member_id,week_start,week_end HAVING SUM(check_amount)>0) checks")
 ]);
 res.json({marketers:m.rows[0].n,orders:o.rows[0].n,checks:k.rows[0].n});
}