import { db } from "hatchable";
import { requireNetworkUser } from "../../lib/network-auth.js";
import { reconcileWeeklyCheckCredits } from "../../lib/wallet-check-reconciliation.js";

export const access = "public";
export const methods = ["GET"];

export default async function handler(req,res){
  const user=await requireNetworkUser(req,res);
  if(!user)return;
  const uid=user.id;
  const profile=await db.query("SELECT id,role,display_name,first_name,second_name,third_name,fourth_name,avatar_url,referral_code,status,deleted_at,login_blocked FROM app_profiles WHERE id=$1 LIMIT 1",[uid]);
  if(!profile.rows.length || profile.rows[0].role!=="marketer") return res.status(403).json({error:"marketer_only"});
  if(profile.rows[0].deleted_at || profile.rows[0].status==="deleted") return res.status(403).json({error:"account_deleted"});
  if(profile.rows[0].login_blocked) return res.status(403).json({error:"login_blocked"});

  // Ensure recorded weekly checks are reflected in the real spendable wallet.
  await reconcileWeeklyCheckCredits(uid);

  const [walletRaw,adminMoves,adminHistory,adminLedger,transactionsRaw,direct,directPendingRows,checks,checkRecords,otherCommissions,otherCommissionRows,withdrawals]=await Promise.all([
    db.query("SELECT COALESCE(balance,0)::numeric AS balance FROM wallets WHERE user_id=$1",[uid]),
    db.query(`SELECT COALESCE(SUM(amount) FILTER(WHERE type='admin_add' AND amount>0),0)::numeric AS transferred_in,
                     COALESCE(ABS(SUM(amount) FILTER(WHERE type='admin_remove' AND amount<0)),0)::numeric AS removed_by_admin
              FROM wallet_transactions WHERE user_id=$1`,[uid]),
    db.query(`SELECT COALESCE(SUM(CASE WHEN action='remove' THEN -ABS(amount) ELSE ABS(amount) END),0)::numeric AS net,
                     COALESCE(SUM(ABS(amount)) FILTER(WHERE action='add'),0)::numeric AS credited,
                     COALESCE(SUM(ABS(amount)) FILTER(WHERE action='remove'),0)::numeric AS removed
              FROM admin_manual_wallet_actions WHERE marketer_id=$1`,[uid]),
    db.query(`SELECT id,action,amount,created_at FROM admin_manual_wallet_actions WHERE marketer_id=$1 ORDER BY created_at DESC LIMIT 100`,[uid]),
    db.query(`SELECT id,type,
                     CASE WHEN type IN ('store_purchase','withdrawal','admin_remove','wallet_debit','purchase') THEN -ABS(amount)
                          ELSE amount END AS amount,
                     CASE WHEN type IN ('store_purchase','withdrawal','admin_remove','wallet_debit','purchase') OR amount<0 THEN 'out' ELSE 'in' END AS direction,
                     reference,created_at
              FROM wallet_transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`,[uid]),
    db.query(`SELECT COALESCE(SUM(amount),0)::numeric AS total,
                     COALESCE(SUM(amount) FILTER(WHERE status='paid'),0)::numeric AS paid,
                     COALESCE(SUM(amount) FILTER(WHERE status='payable'),0)::numeric AS payable,
                     COALESCE(SUM(amount) FILTER(WHERE status='pending'),0)::numeric AS pending
              FROM network_direct_commissions WHERE marketer_id=$1`,[uid]),
    db.query(`SELECT d.id,d.amount,d.created_at,d.order_id
                FROM network_direct_commissions d
                JOIN orders o ON o.id=d.order_id
               WHERE d.marketer_id=$1 AND d.status='pending'
               ORDER BY d.created_at DESC LIMIT 100`,[uid]),
    db.query(`SELECT COALESCE(SUM(check_amount),0)::numeric AS total,
                     COALESCE(SUM(check_amount) FILTER(WHERE check_amount>0),0)::numeric AS positive_total,
                     COUNT(*) FILTER(WHERE check_amount>0)::int AS count
              FROM network_bv_settlements WHERE member_id=$1`,[uid]),
    db.query(`SELECT id,account_position,week_start,week_end,check_amount,settled_at
              FROM network_bv_settlements WHERE member_id=$1 AND check_amount>0
              ORDER BY settled_at DESC,account_position ASC LIMIT 200`,[uid]),
    db.query("SELECT COALESCE(SUM(amount),0)::numeric AS total, COALESCE(SUM(amount) FILTER(WHERE status='paid'),0)::numeric AS paid, COALESCE(SUM(amount) FILTER(WHERE status='pending'),0)::numeric AS pending FROM commission_ledger WHERE marketer_id=$1",[uid]),
    db.query("SELECT id,amount,status,order_id,created_at FROM commission_ledger WHERE marketer_id=$1 ORDER BY created_at DESC LIMIT 200",[uid]),
    db.query("SELECT id,amount,status,note,created_at FROM withdrawal_requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20",[uid])
  ]);
  const scopedWalletResult = await db.query("SELECT get_marketer_wallet_state($1) AS state", [uid]);
  let scopedWallet = scopedWalletResult.rows[0]?.state || {};
  if (typeof scopedWallet === "string") { try { scopedWallet = JSON.parse(scopedWallet); } catch { scopedWallet = {}; } }
  const wallet = { rows: scopedWallet.wallet_found ? [{ balance: scopedWallet.balance }] : [] };
  const transactions = { rows: Array.isArray(scopedWallet.transactions) ? scopedWallet.transactions : [] };
  // Weekly checks are credited to wallets when paid. Keep the display tied to the
  // spendable wallet balance; summing settlement rows again would count paid checks twice.
  const pendingWithdrawals = withdrawals.rows
    .filter(x => ['pending','قيد الانتظار','under_review','in_review','processing','جارى المراجعة','جاري المراجعة','قيد المراجعة'].includes(String(x.status||'').trim().toLowerCase()))
    .reduce((sum,x)=>sum+Number(x.amount||0),0);
  const storedBalance = wallet.rows.length
      ? Number(wallet.rows[0]?.balance||0)
      : Number(adminHistory.rows[0]?.net||0);
  const currentBalance = storedBalance - pendingWithdrawals;

  return res.json({
    ok:true,
    account:{id:profile.rows[0].id,name:[profile.rows[0].first_name,profile.rows[0].second_name,profile.rows[0].third_name,profile.rows[0].fourth_name].filter(Boolean).join(" ")||profile.rows[0].display_name||req.user?.name||req.user?.email||"",referral_code:profile.rows[0].referral_code||"",avatar_url:profile.rows[0].avatar_url||null},
    // If the wallet row is absent, recover the displayed balance from the existing
    // protected admin-adjustment ledger. Never override a present wallet row: it may
    // already reflect legitimate purchases or withdrawals.
    balance:Math.max(0,currentBalance),
    admin_transfers:{
      credited:Number(adminMoves.rows[0]?.transferred_in||0)||Number(adminHistory.rows[0]?.credited||0),
      removed:Number(adminMoves.rows[0]?.removed_by_admin||0)||Number(adminHistory.rows[0]?.removed||0)
    },
    earnings:{
      direct_commissions:{total:Number(direct.rows[0]?.total||0),paid:Number(direct.rows[0]?.paid||0),payable:Number(direct.rows[0]?.payable||0),pending:Number(direct.rows[0]?.pending||0)},
      weekly_checks:{total:Number(checks.rows[0]?.total||0),count:Number(checks.rows[0]?.count||0)},
      other_commissions:{total:Number(otherCommissions.rows[0]?.total||0),paid:Number(otherCommissions.rows[0]?.paid||0),pending:Number(otherCommissions.rows[0]?.pending||0)}
    },
    transactions:[
      ...transactions.rows,
      ...directPendingRows.rows.map(x=>({id:'direct-pending-'+x.id,type:'direct_commission_pending',amount:Number(x.amount||0),direction:'pending',reference:'عمولة مؤجلة حتى تحديث السبت 12:00 ص',created_at:x.created_at})),
      ...adminLedger.rows.filter(x=>!transactions.rows.some(t=>t.type===(x.action==='remove'?'admin_remove':'admin_add')&&Math.abs(Number(t.amount||0))===Math.abs(Number(x.amount||0))&&Math.abs(new Date(t.created_at).getTime()-new Date(x.created_at).getTime())<=10000)).map(x=>({id:'admin-'+x.id,type:x.action==='remove'?'admin_remove':'admin_add',amount:x.action==='remove'?-Math.abs(Number(x.amount||0)):Math.abs(Number(x.amount||0)),direction:x.action==='remove'?'out':'in',reference:null,created_at:x.created_at})),
      ...otherCommissionRows.rows.map(x=>({id:'network-commission-'+x.id,type:'network_commission',amount:Number(x.amount||0),direction:'in',status:x.status||'pending',reference:x.order_id?'طلب '+x.order_id:'عمولة شبكة',created_at:x.created_at})),
      ...checkRecords.rows.map(x=>({id:'check-'+x.id,type:'weekly_check',amount:Number(x.check_amount||0),direction:'check',reference:'التوكيل '+String(x.account_position||1).padStart(2,'0'),created_at:x.settled_at}))
    ].sort((a,b)=>new Date(b.created_at||0)-new Date(a.created_at||0)).slice(0,100),
    check_records:checkRecords.rows,
    withdrawals:withdrawals.rows
  });
}