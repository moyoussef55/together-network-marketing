import { db } from "hatchable";

const QUALIFIED = ["paid","processing","shipped","delivered","completed"];

async function allocateQualifiedSales(){
  const result=await db.query(`
    WITH RECURSIVE qualified_orders AS (
      SELECT o.id::text AS order_id,o.marketer_id::text AS source_member_id,
             COALESCE(o.created_at,now()) AS sale_at,
             COALESCE(SUM(oi.quantity*pr.bv) FILTER(WHERE pr.commissionable=true),0)::int AS bv
        FROM orders o JOIN order_items oi ON oi.order_id=o.id JOIN products pr ON pr.id=oi.product_id
       WHERE o.marketer_id IS NOT NULL AND o.status=ANY($1::text[])
         AND NOT EXISTS (SELECT 1 FROM app_profiles ap WHERE ap.id=o.marketer_id AND (ap.activation_blocked=true OR ap.deleted_at IS NOT NULL))
       GROUP BY o.id,o.marketer_id,o.created_at
      HAVING COALESCE(SUM(oi.quantity*pr.bv) FILTER(WHERE pr.commissionable=true),0)>0
    ), chain AS (
      SELECT q.order_id,q.source_member_id,q.sale_at,q.bv,p.owner_marketer_id::text AS upline_member_id,
             p.account_position,p.side,ARRAY[q.source_member_id]::text[] AS seen
        FROM qualified_orders q JOIN network_placements p ON p.member_id::text=q.source_member_id
      UNION ALL
      SELECT c.order_id,c.source_member_id,c.sale_at,c.bv,p.owner_marketer_id::text,p.account_position,p.side,
             c.seen||p.owner_marketer_id::text
        FROM chain c JOIN network_placements p ON p.member_id::text=c.upline_member_id
       WHERE NOT p.owner_marketer_id::text=ANY(c.seen)
    ), expected_positions AS (
      -- The position account keeps the local side; account 01 derives its side
      -- from branch position 02 (left) / 03 (right), never from the child's local side.
      SELECT DISTINCT c.order_id,c.source_member_id,c.upline_member_id,
             CASE WHEN NOT EXISTS (
               SELECT 1 FROM network_placements parent
                WHERE parent.member_id::text=c.upline_member_id
             ) THEN 1 ELSE c.account_position END AS account_position,
             CASE WHEN NOT EXISTS (
               SELECT 1 FROM network_placements parent
                WHERE parent.member_id::text=c.upline_member_id
             ) THEN CASE c.account_position WHEN 2 THEN 'left' WHEN 3 THEN 'right' ELSE c.side END
             ELSE c.side END AS side,
             c.bv,c.sale_at
        FROM chain c
      UNION
      SELECT DISTINCT c.order_id,c.source_member_id,c.upline_member_id,
             1 AS account_position,
             CASE c.account_position WHEN 2 THEN 'left' WHEN 3 THEN 'right' ELSE c.side END AS side,
             c.bv,c.sale_at
        FROM chain c
       WHERE c.account_position<>1
         AND EXISTS (SELECT 1 FROM network_placements parent WHERE parent.member_id::text=c.upline_member_id)
    )
    INSERT INTO network_bv_ledger(order_id,source_member_id,upline_member_id,account_position,side,bv,sale_at)
    SELECT ep.order_id,ep.source_member_id,ep.upline_member_id,ep.account_position,ep.side,ep.bv,ep.sale_at
      FROM expected_positions ep
      JOIN app_profiles recipient ON recipient.id=ep.upline_member_id
      CROSS JOIN LATERAL (
        SELECT COALESCE(SUM(oi.quantity*pr.bv) FILTER(WHERE pr.commissionable=true),0)::int AS purchase_bv
          FROM orders own_o
          JOIN order_items oi ON oi.order_id=own_o.id
          JOIN products pr ON pr.id=oi.product_id
         WHERE own_o.marketer_id=recipient.id
           AND own_o.status=ANY($1::text[])
           AND own_o.created_at<=ep.sale_at
      ) own
     WHERE recipient.activation_started_at IS NOT NULL AND recipient.activation_started_at<=ep.sale_at
       AND COALESCE(recipient.activation_blocked,false)=false AND recipient.deleted_at IS NULL
       AND ep.account_position <= GREATEST(
         COALESCE(recipient.admin_tier_override,0),
         CASE WHEN own.purchase_bv>=3000 THEN 3
              WHEN own.purchase_bv>=2000 THEN 2
              WHEN own.purchase_bv>=1000 THEN 1
              ELSE 0 END
       )
    ON CONFLICT(order_id,upline_member_id,account_position,side) DO NOTHING
  `,[QUALIFIED]);
  return result.rowCount||0;
}

async function createDirectCommissions(){
  const orders=await db.query(`
    SELECT DISTINCT o.id FROM orders o
    JOIN order_items oi ON oi.order_id=o.id
    JOIN products pr ON pr.id=oi.product_id AND pr.commissionable=true
    WHERE o.status=ANY($1::text[]) AND o.marketer_id IS NOT NULL
      AND o.created_at IS NOT NULL
  `,[QUALIFIED]);
  for(const order of orders.rows) await db.query("SELECT credit_direct_commission_for_order($1::uuid)",[order.id]);
}

async function refreshTotals(){
  await db.query(`
    UPDATE network_bv_balances b SET
      total_right=COALESCE((SELECT SUM(l.bv) FROM network_bv_ledger l WHERE l.upline_member_id=b.member_id AND l.account_position=b.account_position AND l.side='right'),0),
      total_left=COALESCE((SELECT SUM(l.bv) FROM network_bv_ledger l WHERE l.upline_member_id=b.member_id AND l.account_position=b.account_position AND l.side='left'),0),
      updated_at=now()
  `);
  await db.query(`
    INSERT INTO network_bv_balances(member_id,account_position,total_right,total_left)
    SELECT upline_member_id,account_position,COALESCE(SUM(bv) FILTER(WHERE side='right'),0),COALESCE(SUM(bv) FILTER(WHERE side='left'),0)
      FROM network_bv_ledger GROUP BY upline_member_id,account_position
    ON CONFLICT(member_id,account_position) DO UPDATE SET total_right=EXCLUDED.total_right,total_left=EXCLUDED.total_left,updated_at=now()
  `);
}

async function settleWeek({manual=false}={}){
  const clock=await db.query(`SELECT extract(isodow from timezone('Africa/Cairo',now()))::int AS dow,
    extract(hour from timezone('Africa/Cairo',now()))::int AS hour,timezone('Africa/Cairo',now())::date AS cairo_date`);
  const c=clock.rows[0];
  if(!manual&&(Number(c.dow)!==6||Number(c.hour)!==0))return{settled:false,reason:"not_friday_cutoff"};
  let weekEnd;
  if(manual){
    const next=await db.query(`SELECT (timezone('Africa/Cairo',now())::date + ((6-extract(isodow from timezone('Africa/Cairo',now()))::int+7)%7))::date AS d`);
    weekEnd=String(next.rows[0].d);
    if(weekEnd===String(c.cairo_date)){
      const plus=await db.query("SELECT ($1::date+7)::date AS d",[weekEnd]); weekEnd=String(plus.rows[0].d);
    }
  } else weekEnd=String(c.cairo_date);
  const start=await db.query("SELECT ($1::date-7)::date AS d",[weekEnd]);
  const ws=String(start.rows[0].d);
  if(!manual){
    const finalized=await db.query("SELECT 1 FROM network_bv_settlements WHERE week_end=$1::date AND is_finalized=true LIMIT 1",[weekEnd]);
    if(finalized.rows.length)return{settled:false,reason:"already_settled",week_start:ws,week_end:weekEnd};
  }
  const cfg=await db.query("SELECT level FROM commission_rules WHERE name='weekly_check_amount' LIMIT 1");
  const checkRate=Math.max(0,Number(cfg.rows[0]?.level??1500));
  const accounts=await db.query("SELECT member_id,account_position,carry_right,carry_left FROM network_bv_balances");
  let count=0,checks=0;
  for(const a of accounts.rows){
    const period=await db.query(`SELECT COALESCE(SUM(bv) FILTER(WHERE side='right'),0)::bigint AS right_bv,
      COALESCE(SUM(bv) FILTER(WHERE side='left'),0)::bigint AS left_bv
      FROM network_bv_ledger WHERE upline_member_id=$1 AND account_position=$2
        AND sale_at >= ($3::date::timestamp AT TIME ZONE 'Africa/Cairo')
        AND sale_at < ($4::date::timestamp AT TIME ZONE 'Africa/Cairo')`,
      [a.member_id,a.account_position,ws,weekEnd]);
    const right=Number(period.rows[0].right_bv||0)+Number(a.carry_right||0);
    const left=Number(period.rows[0].left_bv||0)+Number(a.carry_left||0);
    const matched=Math.floor(Math.min(right,left)/3000)*3000;
    // Keep the existing matching/check calculation intact; apply Max Out and
    // Flash Out only as payout/carry rules for this account_position.
    const flashOut=matched>=24000; // 8 or more matched checks in this franchise.
    const maxOut=matched>=21000 && matched<24000; // 7 matched checks.
    const calculatedAmount=(matched/3000)*checkRate;
    const amount=(flashOut||maxOut)?10000:Math.min(10000,calculatedAmount);
    // Flash Out clears only this franchise's carry. Lifetime totals and all
    // ledgers/settlement history remain untouched; Max Out carries the remainder.
    const carryRight=flashOut?0:right-matched;
    const carryLeft=flashOut?0:left-matched;
    const ins=await db.query(`INSERT INTO network_bv_settlements(member_id,account_position,week_start,week_end,right_bv,left_bv,matched_bv,check_amount,carry_right,carry_left,is_finalized)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT(member_id,account_position,week_start,week_end) DO UPDATE SET
        right_bv=EXCLUDED.right_bv,left_bv=EXCLUDED.left_bv,matched_bv=EXCLUDED.matched_bv,
        check_amount=EXCLUDED.check_amount,carry_right=EXCLUDED.carry_right,carry_left=EXCLUDED.carry_left,
        is_finalized=EXCLUDED.is_finalized,
        settled_at=CASE WHEN $12::boolean THEN now() ELSE network_bv_settlements.settled_at END
      RETURNING id`,
      [a.member_id,a.account_position,ws,weekEnd,right,left,matched,amount,carryRight,carryLeft,!manual,!manual]);
    if(!manual){
      await db.query("UPDATE network_bv_balances SET carry_right=$3,carry_left=$4,updated_at=now() WHERE member_id=$1 AND account_position=$2",[a.member_id,a.account_position,carryRight,carryLeft]);
    }
    count++; if(amount>0)checks++;
  }
  return{settled:true,manual,week_start:ws,week_end:weekEnd,accounts:count,checks,check_amount:checkRate};
}

export async function runNetworkUpdate({manual=false}={}){
  if(!manual){
    const enabled=await db.query("SELECT rate FROM commission_rules WHERE name='automatic_update_enabled' LIMIT 1");
    if(Number(enabled.rows[0]?.rate??1)!==1)return{ok:true,skipped:true,reason:"automatic_update_disabled"};
  }
  const allocated=await allocateQualifiedSales();
  await createDirectCommissions();
  await refreshTotals();
  const settlement=await settleWeek({manual});
  let directCommissionsReleased=0;
  if(manual||settlement.settled||settlement.reason==="already_settled"){
    const released=manual
      ? await db.query("SELECT release_due_direct_commissions(now()) AS released")
      : await db.query("SELECT release_due_direct_commissions(($1::date::timestamp AT TIME ZONE 'Africa/Cairo')) AS released",[settlement.week_end||null]);
    directCommissionsReleased=Number(released.rows[0]?.released||0);
  }
  return{ok:true,allocated,settlement,direct_commissions_released:directCommissionsReleased,manual};
}