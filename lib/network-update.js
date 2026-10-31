import { db } from "hatchable";

const QUALIFIED = ["paid","processing","shipped","delivered","completed"];

async function allocateQualifiedSales(){
  const result=await db.query(`
    WITH RECURSIVE qualified_orders AS (
      SELECT o.id::text AS order_id,
             o.marketer_id::text AS source_member_id,
             COALESCE(o.created_at,now()) AS sale_at,
             source.activation_started_at AS source_activation_at,
             COALESCE(SUM(oi.quantity*pr.bv) FILTER(WHERE pr.commissionable=true),0)::int AS bv
        FROM orders o
        JOIN order_items oi ON oi.order_id=o.id
        JOIN products pr ON pr.id=oi.product_id
        JOIN app_profiles source ON source.id::text=o.marketer_id::text
       WHERE o.marketer_id IS NOT NULL
         AND o.status=ANY($1::text[])
         AND source.activation_started_at IS NOT NULL
         AND source.activation_started_at<=COALESCE(o.created_at,now())
         AND source.status='active'
         AND COALESCE(source.activation_blocked,false)=false
         AND source.deleted_at IS NULL
       GROUP BY o.id,o.marketer_id,o.created_at,source.activation_started_at
      HAVING COALESCE(SUM(oi.quantity*pr.bv) FILTER(WHERE pr.commissionable=true),0)>0
    ), chain AS (
      SELECT q.order_id,q.source_member_id,q.sale_at,q.source_activation_at,q.bv,
             p.owner_marketer_id::text AS upline_member_id,
             p.account_position,p.side,
             ARRAY[q.source_member_id,p.owner_marketer_id::text]::text[] AS seen
        FROM qualified_orders q
        JOIN network_placements p ON p.member_id::text=q.source_member_id
      UNION ALL
      SELECT c.order_id,c.source_member_id,c.sale_at,c.source_activation_at,c.bv,
             p.owner_marketer_id::text,p.account_position,p.side,
             c.seen||p.owner_marketer_id::text
        FROM chain c
        JOIN network_placements p ON p.member_id::text=c.upline_member_id
       WHERE NOT p.owner_marketer_id::text=ANY(c.seen)
    ), expected_positions AS (
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
             c.bv,c.sale_at,c.source_activation_at
        FROM chain c
      UNION
      SELECT DISTINCT c.order_id,c.source_member_id,c.upline_member_id,
             1 AS account_position,
             CASE c.account_position WHEN 2 THEN 'left' WHEN 3 THEN 'right' ELSE c.side END AS side,
             c.bv,c.sale_at,c.source_activation_at
        FROM chain c
       WHERE c.account_position<>1
         AND EXISTS (SELECT 1 FROM network_placements parent WHERE parent.member_id::text=c.upline_member_id)
    ), active_expected_positions AS (
      SELECT DISTINCT ep.order_id,ep.source_member_id,ep.sale_at,ep.source_activation_at,ep.bv,
             ep.upline_member_id,ep.account_position,ep.side
        FROM expected_positions ep
        JOIN app_profiles recipient ON recipient.id::text=ep.upline_member_id
        CROSS JOIN LATERAL (
          SELECT COALESCE(SUM(oi.quantity*pr.bv) FILTER(WHERE pr.commissionable=true),0)::int AS purchase_bv
            FROM orders own_o
            JOIN order_items oi ON oi.order_id=own_o.id
            JOIN products pr ON pr.id=oi.product_id
           WHERE own_o.marketer_id::text=recipient.id::text
             AND own_o.status=ANY($1::text[])
             AND own_o.created_at<=ep.sale_at
        ) own
       WHERE recipient.activation_started_at IS NOT NULL
         AND recipient.activation_started_at<=ep.sale_at
         AND recipient.activation_started_at<=ep.source_activation_at
         AND recipient.status='active'
         AND COALESCE(recipient.activation_blocked,false)=false
         AND recipient.deleted_at IS NULL
         AND ep.account_position <= GREATEST(
           COALESCE(recipient.admin_tier_override,0),
           CASE WHEN own.purchase_bv>=3000 THEN 3
                WHEN own.purchase_bv>=2000 THEN 2
                WHEN own.purchase_bv>=1000 THEN 1
                ELSE 0 END
         )
    )
    INSERT INTO network_bv_ledger(order_id,source_member_id,upline_member_id,account_position,side,bv,sale_at)
    SELECT ep.order_id,ep.source_member_id,ep.upline_member_id,ep.account_position,ep.side,ep.bv,ep.sale_at
      FROM active_expected_positions ep
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
      total_right=COALESCE((SELECT SUM(l.bv) FROM network_bv_ledger l WHERE l.upline_member_id=b.member_id AND l.account_position=b.account_position AND l.side='right'),0)
        + COALESCE((SELECT a.adjustment_right FROM network_bv_opening_adjustments a WHERE a.member_id=b.member_id AND a.account_position=b.account_position),0),
      total_left=COALESCE((SELECT SUM(l.bv) FROM network_bv_ledger l WHERE l.upline_member_id=b.member_id AND l.account_position=b.account_position AND l.side='left'),0)
        + COALESCE((SELECT a.adjustment_left FROM network_bv_opening_adjustments a WHERE a.member_id=b.member_id AND a.account_position=b.account_position),0),
      updated_at=now()
  `);
  await db.query(`
    WITH positions AS (
      SELECT upline_member_id AS member_id,account_position FROM network_bv_ledger
      UNION
      SELECT member_id,account_position FROM network_bv_opening_adjustments
    )
    INSERT INTO network_bv_balances(member_id,account_position,total_right,total_left)
    SELECT p.member_id,p.account_position,
           COALESCE((SELECT SUM(l.bv) FROM network_bv_ledger l
                      WHERE l.upline_member_id=p.member_id AND l.account_position=p.account_position AND l.side='right'),0)
             + COALESCE(a.adjustment_right,0),
           COALESCE((SELECT SUM(l.bv) FROM network_bv_ledger l
                      WHERE l.upline_member_id=p.member_id AND l.account_position=p.account_position AND l.side='left'),0)
             + COALESCE(a.adjustment_left,0)
      FROM positions p
      LEFT JOIN network_bv_opening_adjustments a
        ON a.member_id=p.member_id AND a.account_position=p.account_position
    ON CONFLICT(member_id,account_position) DO UPDATE SET
      total_right=EXCLUDED.total_right,total_left=EXCLUDED.total_left,updated_at=now()
  `);
}

async function settleWeek({manual=false}={}){
  const clock=await db.query(`SELECT extract(isodow from timezone('Africa/Cairo',now()))::int AS dow,
    extract(hour from timezone('Africa/Cairo',now()))::int AS hour,timezone('Africa/Cairo',now())::date AS cairo_date`);
  const c=clock.rows[0];
  const isCutoffDay=Number(c.dow)===6;
  let weekEnd;
  if(manual){
    const next=await db.query(`SELECT (timezone('Africa/Cairo',now())::date + ((6-extract(isodow from timezone('Africa/Cairo',now()))::int+7)%7))::date AS d`);
    weekEnd=String(next.rows[0].d);
    if(weekEnd===String(c.cairo_date)){
      const plus=await db.query("SELECT ($1::date+7)::date AS d",[weekEnd]); weekEnd=String(plus.rows[0].d);
    }
  } else if(isCutoffDay) {
    weekEnd=String(c.cairo_date);
  } else {
    const lastCutoff=await db.query(`SELECT (timezone('Africa/Cairo',now())::date - ((extract(isodow from timezone('Africa/Cairo',now()))::int+1)%7))::date AS d`);
    weekEnd=String(lastCutoff.rows[0].d);
    const previousStart=await db.query("SELECT ($1::date-7)::date AS d",[weekEnd]);
    const incomplete=await db.query(`SELECT 1 FROM network_bv_balances b
      LEFT JOIN network_bv_settlements s ON s.member_id=b.member_id AND s.account_position=b.account_position
        AND s.week_start=$1::date AND s.week_end=$2::date AND s.is_finalized=true
      WHERE (b.total_right>0 OR b.total_left>0 OR b.carry_right>0 OR b.carry_left>0)
        AND s.id IS NULL LIMIT 1`,[String(previousStart.rows[0].d),weekEnd]);
    if(!incomplete.rows.length)return{settled:false,reason:"not_friday_cutoff",week_start:String(previousStart.rows[0].d),week_end:weekEnd};
  }
  const start=await db.query("SELECT ($1::date-7)::date AS d",[weekEnd]);
  const ws=String(start.rows[0].d);
  const cfg=await db.query("SELECT level FROM commission_rules WHERE name='weekly_check_amount' LIMIT 1");
  const checkRate=Math.max(0,Number(cfg.rows[0]?.level??1500));
  const settledResult=await db.query("SELECT settle_network_weekly_checks($1::date,$2::date,$3::numeric,$4::boolean) AS result",[ws,weekEnd,checkRate,manual]);
  let stats=settledResult.rows[0]?.result||{};
  if(typeof stats==="string"){try{stats=JSON.parse(stats)}catch{stats={}}}
  return{settled:true,manual,week_start:ws,week_end:weekEnd,accounts:Number(stats.accounts||0),checks:Number(stats.checks||0),check_amount:checkRate};
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
  const releaseClock=await db.query(`SELECT ((timezone('Africa/Cairo',now())::date
    - ((extract(isodow from timezone('Africa/Cairo',now()))::int+1)%7))::date::timestamp
    AT TIME ZONE 'Africa/Cairo') AS cutoff`);
  const releaseCutoff=manual ? new Date().toISOString() : releaseClock.rows[0].cutoff;
  const released=await db.query("SELECT release_due_direct_commissions($1::timestamptz) AS released",[releaseCutoff]);
  const directCommissionsReleased=Number(released.rows[0]?.released||0);
  let chequeReport=null;
  if(settlement && settlement.settled && settlement.week_start && settlement.week_end){
    const reportResult=await db.query(
      "SELECT record_network_bv_update_report($1::text,$2::date,$3::date,$4::integer,$5::integer,$6::integer,$7::numeric,$8::integer) AS result",
      [manual?"manual":"automatic",settlement.week_start,settlement.week_end,Number(allocated||0),Number(settlement.accounts||0),Number(settlement.checks||0),Number(settlement.check_amount??1500),directCommissionsReleased]
    );
    chequeReport=reportResult.rows[0]?.result||null;
    if(typeof chequeReport==="string"){try{chequeReport=JSON.parse(chequeReport)}catch{chequeReport=null}}
  }
  return{ok:true,allocated,settlement,cheque_report:chequeReport,direct_commissions_released:directCommissionsReleased,manual};
}