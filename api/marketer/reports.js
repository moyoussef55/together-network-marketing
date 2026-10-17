import { db } from "hatchable";
import { requireNetworkUser } from "../../lib/network-auth.js";

export const access = "public";
export const methods = ["GET"];

export default async function handler(req,res){
  const user = await requireNetworkUser(req,res);
  if(!user) return;
  const profile = await db.query("SELECT role,deleted_at,login_blocked,status FROM app_profiles WHERE id=$1 LIMIT 1",[user.id]);
  const p=profile.rows[0];
  if(!p || p.role!=="marketer") return res.status(403).json({error:"marketer_only"});
  if(p.deleted_at || p.login_blocked || ["blocked","deleted"].includes(String(p.status||"").toLowerCase())) return res.status(403).json({error:"account_unavailable"});
  const [result,withdrawals,direct]=await Promise.all([
    db.query(`
      SELECT id,account_position,week_start,week_end,right_bv,left_bv,matched_bv,
             check_amount,carry_right,carry_left,settled_at,is_finalized
        FROM network_bv_settlements
       WHERE member_id=$1 AND COALESCE(check_amount,0) > 0
       ORDER BY week_end DESC, settled_at DESC, account_position ASC
       LIMIT 200
    `,[user.id]),
    db.query(`
      SELECT id,amount,status,note,full_name,transfer_phone,created_at
        FROM withdrawal_requests WHERE user_id=$1
       ORDER BY created_at DESC LIMIT 200
    `,[user.id]),
    db.query(`
      SELECT dc.id,dc.amount,dc.status,dc.order_id,dc.created_at,dc.paid_at,
             o.total AS order_total,o.status AS order_status
        FROM network_direct_commissions dc
        LEFT JOIN orders o ON o.id=dc.order_id
       WHERE dc.marketer_id=$1
       ORDER BY COALESCE(dc.paid_at,dc.created_at) DESC,dc.created_at DESC
       LIMIT 500
    `,[user.id])
  ]);
  return res.json({ok:true,
    reports:result.rows.map(r=>({
      ...r,
      right_bv:Number(r.right_bv||0),left_bv:Number(r.left_bv||0),
      matched_bv:Number(r.matched_bv||0),check_amount:Number(r.check_amount||0),
      carry_right:Number(r.carry_right||0),carry_left:Number(r.carry_left||0),
      check_count:Math.floor(Number(r.check_amount||0)/1500)
    })),
    withdrawal_reports:withdrawals.rows.map(r=>({...r,amount:Number(r.amount||0)})),
    direct_commission_reports:direct.rows.map(r=>({...r,amount:Number(r.amount||0),order_total:Number(r.order_total||0)}))
  });
}