import { db } from "hatchable";

import { requireAdminSession } from "../../lib/admin-auth.js";
export const access = "public";
export const methods=["GET"];

export default async function(req,res){if(!(await requireAdminSession(req,res)))return;
  const id=String(req.query?.id||"").trim();
  if(!id)return res.status(400).json({error:"missing_id"});
  let target=await db.query(
    "SELECT id,display_name,referral_code,role,status,deleted_at,avatar_url,cover_url,created_at,admin_tier_override FROM app_profiles WHERE id=$1 LIMIT 1",
    [id]
  );
  if(!target.rows.length){
    const source=await db.query("SELECT source_id,payload FROM legacy_import_source_records WHERE collection_name='agents' AND source_id=$1 LIMIT 1",[id]);
    if(!source.rows.length)return res.status(404).json({error:"not_found"});
    const x=source.rows[0].payload||{};
    target={rows:[{
      id:source.rows[0].source_id,
      display_name:[x.firstName,x.secondName,x.thirdName,x.lastName].filter(Boolean).join(" ")||"مسوق مستورد",
      referral_code:String(x.id||source.rows[0].source_id),
      role:"marketer",status:"active",deleted_at:null,
      avatar_url:x.profileImage||null,cover_url:x.backgroundImage||null,created_at:null,admin_tier_override:0
    }]};
  }

  const sales=await db.query(
    `SELECT COUNT(*)::int AS qualified_sales
       FROM orders o
      WHERE o.marketer_id=$1
        AND o.status=ANY($2::text[])
        AND EXISTS (
          SELECT 1 FROM order_items oi
          JOIN products pr ON pr.id=oi.product_id
          WHERE oi.order_id=o.id AND pr.commissionable=true
        )`,
    [id,["paid","processing","shipped","delivered","completed"]]
  );
  const bv=await db.query(
    `SELECT COALESCE(SUM(oi.quantity*oi.bv),0)::int AS purchase_bv
       FROM orders o JOIN order_items oi ON oi.order_id=o.id
      WHERE o.marketer_id=$1 AND o.status=ANY($2::text[])`,
    [id,["paid","processing","shipped","delivered","completed"]]
  );
  const purchaseBv=Number(bv.rows[0]?.purchase_bv||0);
  target.rows[0].qualified_sales=Number(sales.rows[0]?.qualified_sales||0);
  target.rows[0].tier=Math.max(purchaseBv>=3000?3:purchaseBv>=2000?2:purchaseBv>=1000?1:0,Number(target.rows[0].admin_tier_override||0));
  const legacyBv=await db.query(`
    SELECT s.payload
      FROM legacy_import_source_records s
      LEFT JOIN app_profiles p
        ON (NULLIF(s.payload->>'id','') IS NOT NULL AND p.legacy_member_code=s.payload->>'id')
        OR (NULLIF(s.payload->>'email','') IS NOT NULL AND lower(COALESCE(p.email,''))=lower(s.payload->>'email'))
     WHERE s.collection_name='agents' AND (s.source_id=$1 OR p.id=$1)
     ORDER BY CASE WHEN s.source_id=$1 THEN 0 WHEN p.legacy_member_code=s.payload->>'id' THEN 1 ELSE 2 END
     LIMIT 1
  `,[id]);
  const lp=legacyBv.rows[0]?.payload||{};
  const sourceName=[lp.firstName,lp.secondName,lp.thirdName,lp.lastName].filter(Boolean).join(" ");
  const sourceNameLooksCorrupt=/[┘╪ØÃ]/u.test(sourceName);
  const profileNameLooksCorrupt=/[┘╪ØÃ]/u.test(String(target.rows[0].display_name||""));
  if(sourceName && (!sourceNameLooksCorrupt || !target.rows[0].display_name || profileNameLooksCorrupt)) target.rows[0].display_name=sourceName;
  // Match the marketer's own network view: live cumulative balances plus unsettled
  // ledger BV for the current Carry cycle. Legacy import values are fallback only.
  const liveBvQuery=await db.query(`
    SELECT pos.account_position,
           COALESCE(b.total_right,0)::bigint AS total_right,
           COALESCE(b.total_left,0)::bigint AS total_left,
           COALESCE(b.carry_right,0)::bigint
             + COALESCE((SELECT SUM(l.bv) FROM network_bv_ledger l
                  WHERE l.upline_member_id=$1 AND l.account_position=pos.account_position AND l.side='right'
                    AND l.sale_at>COALESCE((SELECT MAX(s.settled_at) FROM network_bv_settlements s
                        WHERE s.member_id=$1 AND s.account_position=pos.account_position),
                      ((date_trunc('week',timezone('Africa/Cairo',now()))::date-2)::timestamp AT TIME ZONE 'Africa/Cairo'))),0)::bigint AS carry_right,
           COALESCE(b.carry_left,0)::bigint
             + COALESCE((SELECT SUM(l.bv) FROM network_bv_ledger l
                  WHERE l.upline_member_id=$1 AND l.account_position=pos.account_position AND l.side='left'
                    AND l.sale_at>COALESCE((SELECT MAX(s.settled_at) FROM network_bv_settlements s
                        WHERE s.member_id=$1 AND s.account_position=pos.account_position),
                      ((date_trunc('week',timezone('Africa/Cairo',now()))::date-2)::timestamp AT TIME ZONE 'Africa/Cairo'))),0)::bigint AS carry_left
      FROM (VALUES (1),(2),(3)) AS pos(account_position)
      LEFT JOIN network_bv_balances b ON b.member_id=$1 AND b.account_position=pos.account_position
     ORDER BY pos.account_position
  `,[id]);
  const legacyBvByPosition={};
  for(const row of liveBvQuery.rows){
    const pos=Number(row.account_position);
    const legacyPos={
      1:{right:Number(lp.rightPv||0),left:Number(lp.leftPv||0),carry_right:Number(lp.carryRight||0),carry_left:Number(lp.carryLeft||0)},
      2:{right:Number(lp.rightPv2||0),left:Number(lp.leftPv2||0),carry_right:Number(lp.carryRight2||0),carry_left:Number(lp.carryLeft2||0)},
      3:{right:Number(lp.rightPv3||0),left:Number(lp.leftPv3||0),carry_right:Number(lp.carryRight3||0),carry_left:Number(lp.carryLeft3||0)}
    }[pos];
    legacyBvByPosition[pos]={
      right:Number(row.total_right||0)||legacyPos.right,
      left:Number(row.total_left||0)||legacyPos.left,
      carry_right:Number(row.carry_right||0)||legacyPos.carry_right,
      carry_left:Number(row.carry_left||0)||legacyPos.carry_left
    };
  }
  target.rows[0].bv_by_position=legacyBvByPosition;

  const parent=await db.query(`
    WITH src AS (
      SELECT source_id,payload,lower(trim(COALESCE(payload->>'email',''))) email
        FROM legacy_import_source_records WHERE collection_name='agents'
    ), mapped AS (
      SELECT s.source_id,s.payload,
             COALESCE(
               (SELECT p.id FROM app_profiles p WHERE NULLIF(s.payload->>'id','') IS NOT NULL AND p.legacy_member_code=s.payload->>'id' LIMIT 1),
               (SELECT p.id FROM app_profiles p WHERE s.email<>'' AND lower(COALESCE(p.email,''))=s.email LIMIT 1),
               s.source_id
             ) target_id
        FROM src s
    ), source_parent AS (
      SELECT COALESCE(par.target_id,m.payload->'parent'->>'$oid') parent_id
        FROM mapped m
        LEFT JOIN mapped par ON par.source_id=m.payload->'parent'->>'$oid'
       WHERE m.target_id=$1 AND NULLIF(m.payload->'parent'->>'$oid','') IS NOT NULL
    )
    SELECT sp.parent_id AS owner_marketer_id,
           CASE WHEN NULLIF(concat_ws(' ',pm.payload->>'firstName',pm.payload->>'secondName',pm.payload->>'thirdName',pm.payload->>'lastName'),'') IS NOT NULL AND concat_ws(' ',pm.payload->>'firstName',pm.payload->>'secondName',pm.payload->>'thirdName',pm.payload->>'lastName') !~ '[┘╪ØÃ]' THEN concat_ws(' ',pm.payload->>'firstName',pm.payload->>'secondName',pm.payload->>'thirdName',pm.payload->>'lastName') ELSE COALESCE(NULLIF(o.display_name,''),o.referral_code,pm.payload->>'id',sp.parent_id) END AS owner_name,
           COALESCE(o.referral_code,pm.payload->>'id') AS owner_referral_code,
           COALESCE(o.avatar_url,pm.payload->>'profileImage') AS owner_avatar_url
      FROM source_parent sp
      LEFT JOIN app_profiles o ON o.id=sp.parent_id
      LEFT JOIN mapped pm ON pm.target_id=sp.parent_id
     WHERE (o.id IS NOT NULL OR pm.source_id IS NOT NULL)
       AND (o.deleted_at IS NULL OR o.id IS NULL)
     LIMIT 1
  `,[id]);
  const parentResult=parent.rows[0] ? parent : await db.query(`
    SELECT o.id AS owner_marketer_id,
           COALESCE(o.display_name,o.referral_code,o.id) AS owner_name,
           o.referral_code AS owner_referral_code,o.avatar_url AS owner_avatar_url
      FROM network_placements p JOIN app_profiles o ON o.id=p.owner_marketer_id
     WHERE p.member_id=$1 AND o.deleted_at IS NULL
     ORDER BY p.created_at DESC NULLS LAST LIMIT 1
  `,[id]);

  const placements=await db.query(
    `WITH src AS (
       SELECT source_id,payload,lower(trim(COALESCE(payload->>'email',''))) email
         FROM legacy_import_source_records WHERE collection_name='agents'
     ), mapped AS (
       SELECT s.source_id,s.payload,
              COALESCE((SELECT p.id FROM app_profiles p WHERE NULLIF(s.payload->>'id','') IS NOT NULL AND p.legacy_member_code=s.payload->>'id' LIMIT 1),
                       (SELECT p.id FROM app_profiles p WHERE s.email<>'' AND lower(COALESCE(p.email,''))=s.email LIMIT 1),s.source_id) target_id
         FROM src s
     ), source_rows AS (
       SELECT v.pos account_position,v.side,COALESCE(c.target_id,v.child_source) member_id,
              m.target_id parent_member_id,
              CASE WHEN NULLIF(concat_ws(' ',c.payload->>'firstName',c.payload->>'secondName',c.payload->>'thirdName',c.payload->>'lastName'),'') IS NOT NULL AND concat_ws(' ',c.payload->>'firstName',c.payload->>'secondName',c.payload->>'thirdName',c.payload->>'lastName') !~ '[┘╪ØÃ]' THEN concat_ws(' ',c.payload->>'firstName',c.payload->>'secondName',c.payload->>'thirdName',c.payload->>'lastName') ELSE COALESCE(NULLIF(a.display_name,''),a.referral_code,v.child_source) END member_name,
              a.referral_code,a.avatar_url,a.status,a.deleted_at
         FROM mapped m
         CROSS JOIN LATERAL (VALUES
           (m.payload->'leftChild0'->>'$oid',2,'left'),
           (m.payload->'rightChild0'->>'$oid',2,'right'),
           (m.payload->'leftChild1'->>'$oid',3,'left'),
           (m.payload->'rightChild1'->>'$oid',3,'right')
         ) v(child_source,pos,side)
         LEFT JOIN mapped c ON c.source_id=v.child_source
         LEFT JOIN app_profiles a ON a.id=COALESCE(c.target_id,v.child_source)
        WHERE m.target_id=$1 AND NULLIF(v.child_source,'') IS NOT NULL
          AND v.child_source<>'000000000000000000000000'
     ), db_rows AS (
       SELECT p.account_position,p.side,p.member_id,p.parent_member_id,
              COALESCE(a.display_name,a.referral_code,p.member_id::text) member_name,
              a.referral_code,a.avatar_url,a.status,a.deleted_at
         FROM network_placements p LEFT JOIN app_profiles a ON a.id=p.member_id
        WHERE p.owner_marketer_id=$1 AND p.account_position IN (2,3)
     )
     SELECT * FROM source_rows
     UNION ALL
     SELECT d.* FROM db_rows d
      WHERE NOT EXISTS (
        SELECT 1 FROM source_rows s
         WHERE s.account_position=d.account_position AND s.side=d.side
      )
     ORDER BY account_position,side`,
    [id]
  );

  const teamIds=placements.rows.map(x=>x.member_id).filter(Boolean);
  let teamRows=[];
  if(teamIds.length){
    const r=await db.query(
      `SELECT p.owner_marketer_id,p.account_position,p.side,p.member_id,p.parent_member_id,
              COALESCE(a.display_name,a.referral_code,p.member_id::text) AS member_name,
              a.referral_code,a.avatar_url
         FROM network_placements p
         LEFT JOIN app_profiles a ON a.id=p.member_id
        WHERE p.owner_marketer_id = ANY($1::text[])
        ORDER BY p.owner_marketer_id,p.account_position,
                 CASE WHEN p.side='left' THEN 0 ELSE 1 END`,
      [teamIds]
    );
    teamRows=r.rows;
  }

  const teamByOwner={};
  for(const x of teamRows)(teamByOwner[x.owner_marketer_id]??=[]).push(x);

  const balanceIds=[...new Set([id,...placements.rows.map(x=>String(x.member_id||"")),...teamRows.map(x=>String(x.member_id||""))].filter(Boolean))];
  const walletRows=balanceIds.length?await db.query(`
    SELECT ids.id,
           CASE WHEN EXISTS(SELECT 1 FROM wallets w WHERE w.user_id::text=ids.id)
                     AND (COALESCE((SELECT w.balance FROM wallets w WHERE w.user_id::text=ids.id LIMIT 1),0)<>0
                          OR EXISTS(SELECT 1 FROM wallet_transactions wt WHERE wt.user_id::text=ids.id))
                THEN COALESCE((SELECT w.balance FROM wallets w WHERE w.user_id::text=ids.id LIMIT 1),0)::numeric
                ELSE COALESCE((SELECT SUM(CASE WHEN ma.action='remove' THEN -ABS(ma.amount) ELSE ABS(ma.amount) END)
                               FROM admin_manual_wallet_actions ma WHERE ma.marketer_id::text=ids.id),0)::numeric
           END AS wallet_balance
      FROM unnest($1::text[]) AS ids(id)
  `,[balanceIds]):{rows:[]};
  const balanceById=Object.fromEntries(walletRows.rows.map(x=>[String(x.id),Number(x.wallet_balance||0)]));
  target.rows[0].wallet_balance=balanceById[String(id)]||0;
  for(const x of placements.rows)x.wallet_balance=balanceById[String(x.member_id)]||0;
  for(const x of teamRows)x.wallet_balance=balanceById[String(x.member_id)]||0;

  res.json({
    ok:true,
    target:target.rows[0],
    upline:parentResult.rows[0]||null,
    placements:placements.rows,
    teams:teamByOwner
  });
}