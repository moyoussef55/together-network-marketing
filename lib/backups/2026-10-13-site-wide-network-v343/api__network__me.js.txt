import { db } from "hatchable";
import { requireNetworkUser } from "../../lib/network-auth.js";

export const access = "public";
export const methods = ["GET"];

const QUALIFIED = ["paid","processing","shipped","delivered","completed"];

export default async function(req,res){
  const user=await requireNetworkUser(req,res);
  if(!user)return;
  const userId=user.id;
  const profile=await db.query(
    "SELECT id, role, display_name, referral_code, sponsor_id, status, avatar_url, cover_url FROM app_profiles WHERE id=$1",
    [userId]
  );
  if(!profile.rows.length){
    const code="TO"+userId.replace(/[^a-zA-Z0-9]/g,"").slice(0,5).toLowerCase();
    await db.query(
      "INSERT INTO app_profiles (id,role,referral_code,display_name) VALUES ($1,'marketer',$2,$3) ON CONFLICT (id) DO NOTHING",
      [userId,code,user.name||user.email?.split("@")[0]||"Marketer"]
    );
  }
  const p=await db.query(
    "SELECT id, role, display_name, referral_code, sponsor_id, status, deleted_at, login_blocked, activation_blocked, admin_tier_override, avatar_url, cover_url FROM app_profiles WHERE id=$1",
    [userId]
  );
  if(p.rows[0]?.deleted_at)return res.status(403).json({error:"account_deleted"});
  if(p.rows[0]?.login_blocked)return res.status(403).json({error:"login_blocked"});
  if(p.rows[0]?.role!=="marketer"){
    return res.status(403).json({error:"marketer_only"});
  }

  // Commission payouts are processed only by the admin-triggered or scheduled
  // update job; loading the marketer dashboard must never release commissions.

  const q=await db.query(
    `SELECT COUNT(*)::int AS qualified_sales
     FROM orders o
     WHERE o.marketer_id=$1
       AND o.status = ANY($2::text[])
       AND EXISTS (
         SELECT 1 FROM order_items oi
         JOIN products pr ON pr.id=oi.product_id
         WHERE oi.order_id=o.id AND pr.commissionable=true
       )`,
    [userId,QUALIFIED]
  );
  const sales=Math.max(0,Number(q.rows[0]?.qualified_sales||0));
  await db.query(
    `INSERT INTO network_sales_qualification(marketer_id,qualified_sales)
     VALUES($1,$2)
     ON CONFLICT(marketer_id) DO UPDATE SET qualified_sales=EXCLUDED.qualified_sales,updated_at=now()`,
    [userId,sales]
  );

  // Each of the three positions has its own independent balance account.
  await db.query(
    `INSERT INTO network_balance_accounts(marketer_id,position_no)
     VALUES($1,1),($1,2),($1,3)
     ON CONFLICT(marketer_id,position_no) DO NOTHING`,
    [userId]
  );
  const balanceRows=await db.query(
    `SELECT position_no,left_sales,right_sales,paid_checks
     FROM network_balance_accounts
     WHERE marketer_id=$1 ORDER BY position_no`,
    [userId]
  );
  const balanceByPosition=Object.fromEntries(
    balanceRows.rows.map(r=>[Number(r.position_no),{
      position:Number(r.position_no),
      left_sales:Number(r.left_sales||0),
      right_sales:Number(r.right_sales||0),
      paid_checks:Number(r.paid_checks||0),
      cap:10000
    }])
  );

  const bvRow=await db.query("SELECT COALESCE(SUM(oi.quantity*oi.bv),0)::int AS purchase_bv FROM orders o JOIN order_items oi ON oi.order_id=o.id WHERE o.marketer_id=$1 AND o.status=ANY($2::text[])",[userId,QUALIFIED]);
  const purchaseBv=Number(bvRow.rows[0]?.purchase_bv||0);
  const calculatedTier=purchaseBv>=3000?3:purchaseBv>=2000?2:purchaseBv>=1000?1:0;
  const tier=Math.max(calculatedTier,Number(p.rows[0]?.admin_tier_override||0));
  const payoutRules=await db.query("SELECT name,level FROM commission_rules WHERE name IN ('direct_commission_amount','weekly_check_amount')");
  const payoutValues=Object.fromEntries(payoutRules.rows.map(x=>[x.name,Number(x.level)]));
  const directCommissionAmount=payoutValues.direct_commission_amount??250;
  const weeklyCheckAmount=payoutValues.weekly_check_amount??1500;
  const names=[
    {key:"head",position:"top"},
    {key:"right",position:"right"},
    {key:"left",position:"left"}
  ];
  const nodes=names.map((n,i)=>{
    const active=i<tier;
    const level=tier===0?"inactive":tier===1?"bronze":tier===2?"silver":"gold";
    return {...n,number:i+1,active,color:active?level:"inactive"};
  });
  const [sideCounts,moneyTotals,salesHistory]=await Promise.all([
    db.query(`WITH RECURSIVE team AS (
      SELECT p.member_id,p.side AS root_side FROM network_placements p WHERE p.owner_marketer_id=$1
      UNION ALL
      SELECT p.member_id,t.root_side FROM network_placements p JOIN team t ON p.owner_marketer_id=t.member_id
    )
    SELECT COUNT(*) FILTER(WHERE root_side='left')::int AS left_count,
           COUNT(*) FILTER(WHERE root_side='right')::int AS right_count FROM team`,[userId]),
    db.query(`WITH wallet_state AS (
        SELECT get_marketer_wallet_state($1) AS state
      ), tx AS (
        SELECT value AS item
        FROM wallet_state, jsonb_array_elements(COALESCE(state->'transactions','[]'::jsonb))
      )
      SELECT
        (COALESCE(SUM((item->>'amount')::numeric) FILTER(WHERE (item->>'amount')::numeric>0 AND item->>'type' NOT IN ('admin_remove','admin_add')),0)
          + COALESCE((SELECT SUM(ABS(amount)) FROM admin_manual_wallet_actions WHERE marketer_id=$1 AND action='add'),0))::numeric AS money_in,
        COALESCE(ABS(SUM((item->>'amount')::numeric) FILTER(WHERE (item->>'amount')::numeric<0 OR item->>'type' IN ('store_purchase','withdrawal','admin_remove','wallet_debit','purchase'))),0)::numeric AS money_out
      FROM tx`,[userId]),
    db.query(`SELECT to_char(date_trunc('month',o.created_at),'YYYY-MM') AS month,
                    COUNT(DISTINCT o.id)::int AS sales,
                    COALESCE(SUM(o.total),0)::numeric AS total
               FROM orders o WHERE o.marketer_id=$1 AND o.status=ANY($2::text[])
               GROUP BY date_trunc('month',o.created_at) ORDER BY date_trunc('month',o.created_at) DESC LIMIT 12`,[userId,QUALIFIED])
  ]);
  res.json({
    marketer:{
      id:userId,
      name:p.rows[0].display_name||user.name||user.email,
      referral_code:p.rows[0].referral_code,
      role:p.rows[0].role,
      avatar_url:p.rows[0].avatar_url,
      cover_url:p.rows[0].cover_url
    },
    qualified_sales:sales,
    purchase_bv:purchaseBv,
    left_marketers:Number(sideCounts.rows[0]?.left_count||0),
    right_marketers:Number(sideCounts.rows[0]?.right_count||0),
    money_in:Number(moneyTotals.rows[0]?.money_in||0),
    money_out:Number(moneyTotals.rows[0]?.money_out||0),
    sales_history:salesHistory.rows.slice().reverse().map(x=>({month:x.month,sales:Number(x.sales||0),total:Number(x.total||0)})),
    tier,
    next_sale:tier<3?tier+1:null,
    nodes,
    balance_accounts:[1,2,3].map(position=>balanceByPosition[position]),
    balance_rules:{
      direct_commission:directCommissionAmount,
      checks:[3,6,9,12,15,18,21].map(units=>({units,amount:Math.min(10000,(units/3)*weeklyCheckAmount)})),
      max_total_checks:10000
    },
    rule:{
      ar:["أقل من 1000 BV","1000 BV = برونزي","2000 BV = سيلفر","3000 BV = ذهبي"],
      en:["Under 1000 BV","1000 BV = Bronze","2000 BV = Silver","3000 BV = Gold"]
    }
  });
}