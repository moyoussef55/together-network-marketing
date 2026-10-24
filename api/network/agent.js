import { db } from "hatchable";
import { requireNetworkUser } from "../../lib/network-auth.js";

export const access = "public";

export default async function handler(req, res) {
  const user = await requireNetworkUser(req,res);
  if (!user) return;
  const uid = user.id;

  if (req.method === "GET") {
    const search = String(req.query?.search || "").trim();
    if (search) {
      const q = search.slice(0, 80);
      const normalizedId = q.replace(/(?:01|02|03)$/i, "");
      const found = await db.query(
        `WITH RECURSIVE network AS (
           SELECT $1::text AS member_id
           UNION
           SELECT p.member_id
             FROM network_placements p
             JOIN network n ON n.member_id=p.owner_marketer_id
            WHERE p.account_position IN (2,3)
         )
         SELECT a.id, a.display_name, a.referral_code, a.phone, a.avatar_url
           FROM network n
           JOIN app_profiles a ON a.id=n.member_id
          WHERE a.deleted_at IS NULL
            AND (
              a.id=$2
              OR a.referral_code=$3
              OR a.referral_code=$4
              OR a.display_name ILIKE '%' || $2 || '%'
              OR concat_ws(' ',a.first_name,a.second_name,a.third_name,a.fourth_name) ILIKE '%' || $2 || '%'
              OR COALESCE(a.phone,'') ILIKE '%' || $2 || '%'
            )
          ORDER BY CASE
            WHEN a.id=$2 OR a.referral_code=$2 OR a.referral_code=$3 THEN 0
            WHEN a.display_name ILIKE $2 || '%' THEN 1
            ELSE 2
          END, a.display_name NULLS LAST
          LIMIT 8`,
        [uid, q, q, normalizedId]
      );
      return res.json({ok:true,results:found.rows});
    }

    const requestedMember = String(req.query?.member_id || "").trim();
    let targetId = requestedMember || uid;

    if (targetId !== uid) {
      // Marketers may navigate only to their own descendants. Ancestor/upline
      // traversal is intentionally restricted to the dedicated admin API/page.
      const allowed = await db.query(
        `WITH RECURSIVE src AS (
           SELECT source_id,payload,lower(trim(COALESCE(payload->>'email',''))) email
             FROM legacy_import_source_records WHERE collection_name='agents'
           ), mapped AS (
             SELECT s.source_id,s.payload,
                    COALESCE((SELECT p.id FROM app_profiles p WHERE NULLIF(s.payload->>'id','') IS NOT NULL AND p.legacy_member_code=s.payload->>'id' LIMIT 1),
                             (SELECT p.id FROM app_profiles p WHERE s.email<>'' AND lower(COALESCE(p.email,''))=s.email LIMIT 1),s.source_id) target_id
               FROM src s
           ), source_edges AS (
             SELECT m.target_id parent_id,COALESCE(c.target_id,v.child_source) child_id
               FROM mapped m
               CROSS JOIN LATERAL (VALUES
                 (m.payload->'leftChild0'->>'$oid'),
                 (m.payload->'rightChild0'->>'$oid'),
                 (m.payload->'leftChild1'->>'$oid'),
                 (m.payload->'rightChild1'->>'$oid')
               ) v(child_source)
               LEFT JOIN mapped c ON c.source_id=v.child_source
              WHERE NULLIF(v.child_source,'') IS NOT NULL AND v.child_source<>'000000000000000000000000'
           ), edges AS (
             SELECT owner_marketer_id parent_id,member_id child_id FROM network_placements WHERE account_position IN (2,3)
             UNION SELECT parent_id,child_id FROM source_edges
           ), descendants AS (
             SELECT child_id member_id FROM edges WHERE parent_id=$1
             UNION
             SELECT e.child_id FROM edges e JOIN descendants d ON d.member_id=e.parent_id
           )
           SELECT 1 WHERE $2 IN (SELECT member_id FROM descendants) LIMIT 1`,
        [uid, targetId]
      );
      if (!allowed.rows.length) return res.status(403).json({ error: "network_access_denied" });
    }

    let profile = await db.query(
      `SELECT a.id, a.display_name, a.referral_code, a.role, a.sponsor_id, a.avatar_url, a.cover_url, a.created_at, a.admin_tier_override,
              placement.account_position AS placed_account_position,
              placement.side AS placed_side,
              placement.created_at AS placement_created_at
         FROM app_profiles a
         LEFT JOIN LATERAL (
           SELECT p.account_position, p.side, p.created_at
             FROM network_placements p
            WHERE p.member_id=a.id AND p.account_position IN (2,3)
            ORDER BY p.created_at DESC NULLS LAST
            LIMIT 1
         ) placement ON true
        WHERE a.id=$1 AND a.deleted_at IS NULL
        LIMIT 1`,
      [targetId]
    );
    if (!profile.rows.length) {
      const source=await db.query("SELECT source_id,payload FROM legacy_import_source_records WHERE collection_name='agents' AND source_id=$1 LIMIT 1",[targetId]);
      if(!source.rows.length)return res.status(404).json({error:"agent_not_found"});
      const x=source.rows[0].payload||{};
      profile={rows:[{
        id:source.rows[0].source_id,
        display_name:[x.firstName,x.secondName,x.thirdName,x.lastName].filter(Boolean).join(" ")||"مسوق مستورد",
        referral_code:String(x.id||source.rows[0].source_id),
        role:"marketer",sponsor_id:null,avatar_url:x.profileImage||null,
        cover_url:x.backgroundImage||null,created_at:null,admin_tier_override:0
      }]};
    }

    const sales = await db.query(
      `SELECT COUNT(*)::int AS qualified_sales
         FROM orders o
        WHERE o.marketer_id=$1
          AND o.status = ANY($2::text[])
          AND EXISTS (
            SELECT 1 FROM order_items oi
            JOIN products pr ON pr.id=oi.product_id
            WHERE oi.order_id=o.id AND pr.commissionable=true
          )`,
      [targetId, ["paid","processing","shipped","delivered","completed"]]
    );

    let sponsor = null;
    if (profile.rows[0].sponsor_id) {
      const sp = await db.query(
        `SELECT id, display_name, referral_code
           FROM app_profiles
          WHERE id=$1 AND deleted_at IS NULL
          LIMIT 1`,
        [profile.rows[0].sponsor_id]
      );
      sponsor = sp.rows[0] || null;
    }

    // The actual network parent (upline) is the owner of this member's placement.
    let upline = null;
    const up = await db.query(
      `WITH src AS (
         SELECT source_id,payload,lower(trim(COALESCE(payload->>'email',''))) email
           FROM legacy_import_source_records WHERE collection_name='agents'
       ), mapped AS (
         SELECT s.source_id,s.payload,
                COALESCE((SELECT p.id FROM app_profiles p WHERE NULLIF(s.payload->>'id','') IS NOT NULL AND p.legacy_member_code=s.payload->>'id' LIMIT 1),
                         (SELECT p.id FROM app_profiles p WHERE s.email<>'' AND lower(COALESCE(p.email,''))=s.email LIMIT 1),s.source_id) target_id
           FROM src s
       ), source_parent AS (
         SELECT COALESCE(par.target_id,m.payload->'parent'->>'$oid') parent_id
           FROM mapped m
           LEFT JOIN mapped par ON par.source_id=m.payload->'parent'->>'$oid'
          WHERE m.target_id=$1
            AND NULLIF(m.payload->'parent'->>'$oid','') IS NOT NULL
       )
       SELECT sp.parent_id AS id,
              CASE WHEN NULLIF(concat_ws(' ',pm.payload->>'firstName',pm.payload->>'secondName',pm.payload->>'thirdName',pm.payload->>'lastName'),'') IS NOT NULL AND concat_ws(' ',pm.payload->>'firstName',pm.payload->>'secondName',pm.payload->>'thirdName',pm.payload->>'lastName') !~ '[┘╪ØÃ]' THEN concat_ws(' ',pm.payload->>'firstName',pm.payload->>'secondName',pm.payload->>'thirdName',pm.payload->>'lastName') ELSE COALESCE(NULLIF(o.display_name,''),o.referral_code,pm.payload->>'id',sp.parent_id) END AS display_name,
              COALESCE(o.referral_code,pm.payload->>'id') AS referral_code,
              COALESCE(o.avatar_url,pm.payload->>'profileImage') AS avatar_url
         FROM source_parent sp
         LEFT JOIN app_profiles o ON o.id=sp.parent_id
         LEFT JOIN mapped pm ON pm.target_id=sp.parent_id
        WHERE (o.id IS NOT NULL OR pm.source_id IS NOT NULL)
          AND (o.deleted_at IS NULL OR o.id IS NULL)
       LIMIT 1`,
      [targetId]
    );
    if (up.rows.length) upline = up.rows[0];
    else {
      const oldUp = await db.query(
        `SELECT o.id,o.display_name,o.referral_code,o.avatar_url
           FROM network_placements p JOIN app_profiles o ON o.id=p.owner_marketer_id
          WHERE p.member_id=$1 AND p.account_position IN (2,3) AND o.deleted_at IS NULL
          ORDER BY p.created_at DESC NULLS LAST LIMIT 1`,[targetId]);
      upline = oldUp.rows[0] || null;
    }

    const rows = await db.query(
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
                a.referral_code,a.avatar_url
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
                a.referral_code,a.avatar_url
           FROM network_placements p LEFT JOIN app_profiles a ON a.id=p.member_id
          WHERE p.owner_marketer_id=$1 AND p.account_position IN (2,3)
       )
       -- Imported source slots take precedence; retain legacy rows only for slots absent from source.
       SELECT * FROM source_rows
       UNION ALL
       SELECT d.* FROM db_rows d
        WHERE NOT EXISTS (
          SELECT 1 FROM source_rows s
           WHERE s.account_position=d.account_position AND s.side=d.side
        )
       ORDER BY account_position,side`,
      [targetId]
    );
    // Attach each visible downline's own activation tier so the slot color is correct before opening it.
    const visibleMemberIds=[...new Set(rows.rows.map(x=>String(x.member_id||"")).filter(Boolean))];
    if(visibleMemberIds.length){
      const visibleTiers=await db.query(`
        SELECT p.id::text AS id,
               GREATEST(
                 CASE WHEN COALESCE(SUM(oi.quantity*oi.bv),0)>=3000 THEN 3
                      WHEN COALESCE(SUM(oi.quantity*oi.bv),0)>=2000 THEN 2
                      WHEN COALESCE(SUM(oi.quantity*oi.bv),0)>=1000 THEN 1
                      ELSE 0 END,
                 COALESCE(p.admin_tier_override,0)
               )::int AS tier
          FROM app_profiles p
          LEFT JOIN orders o ON o.marketer_id::text=p.id::text
                            AND o.status=ANY($2::text[])
          LEFT JOIN order_items oi ON oi.order_id=o.id
         WHERE p.id::text=ANY($1::text[]) AND p.deleted_at IS NULL
         GROUP BY p.id,p.admin_tier_override
      `,[visibleMemberIds,["paid","processing","shipped","delivered","completed"]]);
      const tierByMember=Object.fromEntries(visibleTiers.rows.map(x=>[String(x.id),Number(x.tier||0)]));
      for(const row of rows.rows) row.tier=tierByMember[String(row.member_id)]||0;
    }
    const descendants=await db.query(
      `WITH RECURSIVE n AS (
         SELECT p.member_id,p.created_at FROM network_placements p WHERE p.owner_marketer_id=$1 AND p.account_position IN (2,3)
         UNION ALL
         SELECT p.member_id,p.created_at FROM network_placements p JOIN n ON p.owner_marketer_id=n.member_id WHERE p.account_position IN (2,3)
       ) SELECT n.member_id,COALESCE(a.display_name,a.referral_code,n.member_id::text) member_name,a.referral_code,a.avatar_url,n.created_at
         FROM n LEFT JOIN app_profiles a ON a.id=n.member_id ORDER BY n.created_at NULLS LAST LIMIT 4`,[targetId]
    );
    const firstFour=[];
    for(const x of descendants.rows){const rr=await db.query(`SELECT p.account_position,p.side,p.member_id,COALESCE(a.display_name,a.referral_code,p.member_id::text) member_name,a.referral_code,a.avatar_url FROM network_placements p LEFT JOIN app_profiles a ON a.id=p.member_id WHERE p.owner_marketer_id=$1 AND p.account_position IN (2,3) ORDER BY p.account_position,CASE WHEN p.side='left' THEN 0 ELSE 1 END`,[x.member_id]);firstFour.push({...x,authorizations:rr.rows});}
    const legacyBvQuery=await db.query(`
      SELECT s.payload
        FROM legacy_import_source_records s
        LEFT JOIN app_profiles p
          ON (NULLIF(s.payload->>'id','') IS NOT NULL AND p.legacy_member_code=s.payload->>'id')
          OR (NULLIF(s.payload->>'email','') IS NOT NULL AND lower(COALESCE(p.email,''))=lower(s.payload->>'email'))
       WHERE s.collection_name='agents' AND (s.source_id=$1 OR p.id=$1)
       ORDER BY CASE WHEN s.source_id=$1 THEN 0 WHEN p.legacy_member_code=s.payload->>'id' THEN 1 ELSE 2 END
       LIMIT 1
    `,[targetId]);
    const lp=legacyBvQuery.rows[0]?.payload||{};
    const sourceName=[lp.firstName,lp.secondName,lp.thirdName,lp.lastName].filter(Boolean).join(" ");
    const sourceNameLooksCorrupt=/[┘╪ØÃ]/u.test(sourceName);
    const profileNameLooksCorrupt=/[┘╪ØÃ]/u.test(String(profile.rows[0].display_name||""));
    if(sourceName && (!sourceNameLooksCorrupt || !profile.rows[0].display_name || profileNameLooksCorrupt)) profile.rows[0].display_name=sourceName;
    const liveBvQuery=await db.query(`
      SELECT pos.account_position,
             COALESCE(b.total_right,0)::bigint AS total_right,
             COALESCE(b.total_left,0)::bigint AS total_left,
             COALESCE((SELECT s.carry_right FROM network_bv_settlements s WHERE s.member_id=$1 AND s.account_position=pos.account_position AND s.week_end <= (date_trunc('week',timezone('Africa/Cairo',now()))::date-2) ORDER BY s.settled_at DESC LIMIT 1),0)::bigint
               + COALESCE((SELECT SUM(l.bv) FROM network_bv_ledger l
                    WHERE l.upline_member_id=$1 AND l.account_position=pos.account_position AND l.side='right'
                      AND l.sale_at>COALESCE((SELECT MAX(s.settled_at) FROM network_bv_settlements s
                          WHERE s.member_id=$1 AND s.account_position=pos.account_position AND s.week_end <= (date_trunc('week',timezone('Africa/Cairo',now()))::date-2)),
                        ((date_trunc('week',timezone('Africa/Cairo',now()))::date-2)::timestamp AT TIME ZONE 'Africa/Cairo'))),0)::bigint AS carry_right,
             COALESCE((SELECT s.carry_left FROM network_bv_settlements s WHERE s.member_id=$1 AND s.account_position=pos.account_position AND s.week_end <= (date_trunc('week',timezone('Africa/Cairo',now()))::date-2) ORDER BY s.settled_at DESC LIMIT 1),0)::bigint
               + COALESCE((SELECT SUM(l.bv) FROM network_bv_ledger l
                    WHERE l.upline_member_id=$1 AND l.account_position=pos.account_position AND l.side='left'
                      AND l.sale_at>COALESCE((SELECT MAX(s.settled_at) FROM network_bv_settlements s
                          WHERE s.member_id=$1 AND s.account_position=pos.account_position AND s.week_end <= (date_trunc('week',timezone('Africa/Cairo',now()))::date-2)),
                        ((date_trunc('week',timezone('Africa/Cairo',now()))::date-2)::timestamp AT TIME ZONE 'Africa/Cairo'))),0)::bigint AS carry_left
        FROM (VALUES (1),(2),(3)) AS pos(account_position)
        LEFT JOIN network_bv_balances b ON b.member_id=$1 AND b.account_position=pos.account_position
       ORDER BY pos.account_position
    `,[targetId]);
    const legacyBvByPosition={};
    for(const row of liveBvQuery.rows){
      const pos=Number(row.account_position);
      const legacyPos={1:{right:Number(lp.rightPv||0),left:Number(lp.leftPv||0),carry_right:Number(lp.carryRight||0),carry_left:Number(lp.carryLeft||0)},2:{right:Number(lp.rightPv2||0),left:Number(lp.leftPv2||0),carry_right:Number(lp.carryRight2||0),carry_left:Number(lp.carryLeft2||0)},3:{right:Number(lp.rightPv3||0),left:Number(lp.leftPv3||0),carry_right:Number(lp.carryRight3||0),carry_left:Number(lp.carryLeft3||0)}}[pos];
      legacyBvByPosition[pos]={
        right:Number(row.total_right||0)||legacyPos.right,
        left:Number(row.total_left||0)||legacyPos.left,
        carry_right:Number(row.carry_right||0)||legacyPos.carry_right,
        carry_left:Number(row.carry_left||0)||legacyPos.carry_left
      };
    }
    const qualifiedSales=Number(sales.rows[0]?.qualified_sales||0);const bvResult=await db.query("SELECT COALESCE(SUM(oi.quantity*oi.bv),0)::int AS purchase_bv FROM orders o JOIN order_items oi ON oi.order_id=o.id WHERE o.marketer_id=$1 AND o.status=ANY($2::text[])",[targetId,["paid","processing","shipped","delivered","completed"]]);const purchaseBv=Number(bvResult.rows[0]?.purchase_bv||0);const tier=Math.max(purchaseBv>=3000?3:purchaseBv>=2000?2:purchaseBv>=1000?1:0,Number(profile.rows[0]?.admin_tier_override||0));return res.json({target:{...profile.rows[0],qualified_sales:qualifiedSales,tier,sponsor,upline,bv_by_position:legacyBvByPosition},placements:rows.rows,first_four:firstFour,can_navigate_upline:targetId!==uid&&Boolean(upline?.id)});
  }

  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const position = Number(body.account_position);
  const side = body.side;
  const memberId = body.member_id;
  const parentId = body.parent_member_id || null;

  if (![2,3].includes(position) || !["left","right"].includes(side) || !memberId) {
    return res.status(400).json({ error: "invalid_placement" });
  }
  if (memberId === uid) return res.status(400).json({ error: "cannot_place_self" });

  const member = await db.query("SELECT id, role, display_name, referral_code FROM app_profiles WHERE id=$1 AND deleted_at IS NULL LIMIT 1",[memberId]);
  if (!member.rows.length) return res.status(404).json({ error: "agent_not_found" });

  const exists = await db.query("SELECT id FROM network_placements WHERE member_id=$1 LIMIT 1",[memberId]);
  if (exists.rows.length) return res.status(409).json({ error: "agent_already_placed" });

  if (parentId) {
    const parent = await db.query("SELECT id FROM app_profiles WHERE id=$1 AND deleted_at IS NULL LIMIT 1",[parentId]);
    if (!parent.rows.length) return res.status(404).json({ error: "parent_not_found" });
  }

  try {
    await db.query(
      `INSERT INTO network_placements(owner_marketer_id,account_position,side,member_id,parent_member_id)
       VALUES($1,$2,$3,$4,$5)`,
      [uid, position, side, memberId, parentId]
    );
  } catch (e) {
    return res.status(409).json({ error: "placement_conflict" });
  }

  return res.json({ ok:true, placement:{account_position:position,side,member_id:memberId,parent_member_id:parentId} });
}