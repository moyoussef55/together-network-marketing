import { db } from "hatchable";
import { requireAdminSession } from "../../lib/admin-auth.js";
export const access = "public";
export const methods = ["GET","POST"];
const clean=v=>String(v??"").trim();
const body=req=>typeof req.body==="string"?JSON.parse(req.body||"{}"):(req.body||{});
const moneyRows=async(uid,page)=>{
 const offset=(page-1)*10;
 const count=await db.query(`SELECT COUNT(*)::int AS total FROM (
   SELECT wt.id::text AS id FROM wallet_transactions wt
    WHERE wt.user_id=$1 AND NOT (
      wt.type IN ('admin_add','admin_remove')
      AND EXISTS (SELECT 1 FROM admin_manual_wallet_actions ma
        WHERE ma.marketer_id=wt.user_id
          AND ma.action=CASE WHEN wt.type='admin_remove' THEN 'remove' ELSE 'add' END
          AND ABS(ma.amount)=ABS(wt.amount)
          AND ABS(EXTRACT(EPOCH FROM (ma.created_at-wt.created_at))) <= 10
          AND COALESCE(wt.reference,'') LIKE 'admin-%'
      )
    )
   UNION ALL SELECT id::text AS id FROM admin_manual_wallet_actions WHERE marketer_id=$1
   UNION ALL SELECT id::text AS id FROM network_bv_settlements WHERE member_id=$1 AND check_amount>0
 ) x`,[uid]);
 const rows=await db.query(`SELECT * FROM (
   SELECT wt.id::text AS id,wt.type,
     CASE WHEN wt.type IN ('store_purchase','withdrawal','admin_remove','wallet_debit','purchase') THEN -ABS(wt.amount) ELSE wt.amount END AS amount,
     CASE WHEN wt.type IN ('store_purchase','withdrawal','admin_remove','wallet_debit','purchase') OR wt.amount<0 THEN 'out' ELSE 'in' END AS direction,
     wt.reference,wt.created_at FROM wallet_transactions wt WHERE wt.user_id=$1
       AND NOT (
        wt.type IN ('admin_add','admin_remove')
        AND EXISTS (SELECT 1 FROM admin_manual_wallet_actions ma
          WHERE ma.marketer_id=wt.user_id
            AND ma.action=CASE WHEN wt.type='admin_remove' THEN 'remove' ELSE 'add' END
            AND ABS(ma.amount)=ABS(wt.amount)
            AND ABS(EXTRACT(EPOCH FROM (ma.created_at-wt.created_at))) <= 10
            AND COALESCE(wt.reference,'') LIKE 'admin-%'
        )
       )
   UNION ALL
   SELECT ('admin-'||ma.id::text) AS id,CASE WHEN ma.action='remove' THEN 'admin_remove' ELSE 'admin_add' END AS type,
     CASE WHEN ma.action='remove' THEN -ABS(ma.amount) ELSE ABS(ma.amount) END AS amount,
     CASE WHEN ma.action='remove' THEN 'out' ELSE 'in' END AS direction,NULL::text AS reference,ma.created_at
     FROM admin_manual_wallet_actions ma WHERE ma.marketer_id=$1
   UNION ALL
   SELECT ('check-'||id::text) AS id,'weekly_check' AS type,check_amount AS amount,'check' AS direction,
     ('التوكيل '||LPAD(account_position::text,2,'0')) AS reference,settled_at AS created_at
     FROM network_bv_settlements WHERE member_id=$1 AND check_amount>0
 ) history ORDER BY created_at DESC NULLS LAST,id DESC LIMIT 10 OFFSET $2`,[uid,offset]);
 return {transactions:rows.rows,total:Number(count.rows[0]?.total||0),page,pages:Math.max(1,Math.ceil(Number(count.rows[0]?.total||0)/10)),limit:10};
};
async function findMarketer(code){
 const r=await db.query(`SELECT a.id,a.display_name,a.first_name,a.second_name,a.third_name,a.fourth_name,a.email,a.phone,a.referral_code,a.status,a.deleted_at,
   COALESCE(w.balance,0)::numeric AS wallet_balance,
   (SELECT NULLIF(s.payload->>'balance','')::numeric FROM legacy_import_source_records s WHERE s.collection_name='agents' AND s.source_id=a.id::text AND NULLIF(s.payload->>'balance','') IS NOT NULL ORDER BY s.source_id LIMIT 1) AS legacy_wallet_balance,
   COALESCE((SELECT SUM(CASE WHEN action='remove' THEN -ABS(amount) ELSE ABS(amount) END) FROM admin_manual_wallet_actions WHERE marketer_id=a.id),0)::numeric AS admin_ledger_balance,
   EXISTS(SELECT 1 FROM wallets WHERE user_id=a.id) AS has_wallet,
   EXISTS(SELECT 1 FROM wallet_transactions WHERE user_id=a.id) AS has_transactions
   FROM app_profiles a LEFT JOIN wallets w ON w.user_id=a.id
   WHERE a.role='marketer' AND lower(COALESCE(a.referral_code,''))=lower($1) AND a.deleted_at IS NULL LIMIT 1`,[code]);
 if(!r.rows.length)return null;
 const x=r.rows[0];const balance=x.has_wallet?Number(x.wallet_balance||0):(x.legacy_wallet_balance!==null&&x.legacy_wallet_balance!==undefined?Number(x.legacy_wallet_balance):Number(x.admin_ledger_balance||0));
 return {id:x.id,name:[x.first_name,x.second_name,x.third_name,x.fourth_name].filter(Boolean).join(" ")||x.display_name||"",display_name:x.display_name||"",email:x.email||"",phone:x.phone||"",referral_code:x.referral_code||"",status:x.status||"",balance};
}
export default async function(req,res){if(!(await requireAdminSession(req,res)))return;
 if(req.method==="GET"){
  const code=clean(req.query?.code),uid=clean(req.query?.user_id),page=Math.max(1,Math.floor(Number(req.query?.page||1)));
  if(!code&&!uid)return res.json({ok:true,marketer:null});
  let m=null;
  if(uid){
   const r=await db.query("SELECT referral_code FROM app_profiles WHERE id=$1 AND role='marketer' AND deleted_at IS NULL LIMIT 1",[uid]);
   if(r.rows.length)m=await findMarketer(r.rows[0].referral_code);
  }else m=await findMarketer(code);
  if(!m)return res.status(404).json({ok:false,error:"marketer_not_found"});
  const history=await moneyRows(m.id,page);
  return res.json({ok:true,marketer:m,history});
 }
 const b=body(req),code=clean(b.code),amount=Number(b.amount),action=clean(b.action||"add");
 if(!code)return res.status(400).json({ok:false,error:"marketer_code_required"});
 if(!Number.isFinite(amount)||amount<=0||amount>100000000)return res.status(400).json({ok:false,error:"invalid_amount"});
 if(!["add","remove"].includes(action))return res.status(400).json({ok:false,error:"invalid_action"});
 const m=await findMarketer(code);
 if(!m)return res.status(404).json({ok:false,error:"marketer_not_found"});
 if(["blocked","deleted","terminated"].includes(String(m.status).toLowerCase()))return res.status(403).json({ok:false,error:"marketer_not_active"});
 const actor=req.user?.id||null;
 const delta=action==="add"?amount:-amount;
 const reference="admin-"+action+":"+String(actor||"admin");
 const adjusted=await db.query("SELECT admin_adjust_marketer_wallet($1,$2,$3,$4,$5) AS balance",[m.id,delta,action,actor,reference]);
 if(adjusted.rows[0]?.balance===null||adjusted.rows[0]?.balance===undefined)return res.status(400).json({ok:false,error:"insufficient_balance"});
 await db.query("INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'marketer',$3,$4::jsonb)",[actor,action==="add"?"wallet_transfer":"wallet_balance_remove",m.id,JSON.stringify({amount,referral_code:m.referral_code})]).catch(()=>{});
 const updated=await findMarketer(m.referral_code);
 return res.json({ok:true,marketer:updated,amount,action});
}