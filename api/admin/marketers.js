import { db } from "hatchable";
import crypto from "node:crypto";
import { requireAdminSession } from "../../lib/admin-auth.js";
export const access = "public"; export const methods=["GET","POST"];

const body=req=>typeof req.body==="string"?JSON.parse(req.body||"{}"):(req.body||{});
const hash=s=>crypto.createHash("sha256").update(String(s||"")).digest("hex");
const clean=s=>String(s??"").trim();
async function audit(actor,action,id,meta={}){await db.query("INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'marketer',$3,$4::jsonb)",[actor,action,id,JSON.stringify(meta)]).catch(()=>{});}

async function getBvRecipients(id,position,selectedSide){
 // A manual BV sale reaches only uplines activated no later than the source marketer.
 // This prevents a later-activated upline from earning BV on an agent already active beneath it.
 const r=await db.query(`WITH RECURSIVE chain AS (
   SELECT p.owner_marketer_id::text upline_member_id,p.account_position,p.side,
          ARRAY[$1::text,p.owner_marketer_id::text]::text[] seen
     FROM network_placements p WHERE p.member_id::text=$1
   UNION ALL
   SELECT p.owner_marketer_id::text,p.account_position,p.side,c.seen||p.owner_marketer_id::text
     FROM chain c JOIN network_placements p ON p.member_id::text=c.upline_member_id
    WHERE NOT p.owner_marketer_id::text=ANY(c.seen)
 ), mapped AS (
   SELECT DISTINCT c.upline_member_id,
          CASE WHEN NOT EXISTS (
            SELECT 1 FROM network_placements parent
             WHERE parent.member_id::text=c.upline_member_id
          ) THEN 1 ELSE c.account_position END AS account_position,
          CASE WHEN NOT EXISTS (
            SELECT 1 FROM network_placements parent
             WHERE parent.member_id::text=c.upline_member_id
          ) THEN CASE c.account_position WHEN 2 THEN 'left' WHEN 3 THEN 'right' ELSE c.side END
          ELSE c.side END AS side
     FROM chain c
     JOIN app_profiles recipient ON recipient.id::text=c.upline_member_id
     CROSS JOIN LATERAL (
       SELECT activation_started_at FROM app_profiles
        WHERE id::text=$1 AND status='active'
          AND COALESCE(activation_blocked,false)=false AND deleted_at IS NULL
        LIMIT 1
     ) source_activation
    WHERE source_activation.activation_started_at IS NOT NULL
      AND source_activation.activation_started_at<=now()
      AND recipient.activation_started_at IS NOT NULL
      AND recipient.activation_started_at<=source_activation.activation_started_at
      AND recipient.activation_started_at<=now()
      AND recipient.status='active'
      AND COALESCE(recipient.activation_blocked,false)=false
      AND recipient.deleted_at IS NULL
   UNION
   SELECT DISTINCT c.upline_member_id, 1 AS account_position,
          CASE c.account_position WHEN 2 THEN 'left' WHEN 3 THEN 'right' ELSE c.side END AS side
     FROM chain c
     JOIN app_profiles recipient ON recipient.id::text=c.upline_member_id
     CROSS JOIN LATERAL (
       SELECT activation_started_at FROM app_profiles
        WHERE id::text=$1 AND status='active'
          AND COALESCE(activation_blocked,false)=false AND deleted_at IS NULL
        LIMIT 1
     ) source_activation
    WHERE source_activation.activation_started_at IS NOT NULL
      AND source_activation.activation_started_at<=now()
      AND recipient.activation_started_at IS NOT NULL
      AND recipient.activation_started_at<=source_activation.activation_started_at
      AND recipient.activation_started_at<=now()
      AND recipient.status='active'
      AND COALESCE(recipient.activation_blocked,false)=false
      AND recipient.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM network_placements parent WHERE parent.member_id::text=c.upline_member_id)
 )
 SELECT upline_member_id,account_position,side FROM mapped`,[id]);
 const own=await db.query(`SELECT id FROM app_profiles
   WHERE id=$1 AND status='active'
     AND activation_started_at IS NOT NULL AND activation_started_at<=now()
     AND COALESCE(activation_blocked,false)=false AND deleted_at IS NULL LIMIT 1`,[id]);
 const recipients=[];
 if(own.rows.length){
   recipients.push({upline_member_id:id,account_position:position,side:selectedSide});
   if(position!==1) recipients.push({upline_member_id:id,account_position:1,side:position===2?"left":position===3?"right":selectedSide});
 }
 for(const x of r.rows){
   if(!recipients.some(y=>y.upline_member_id===x.upline_member_id&&Number(y.account_position)===Number(x.account_position)&&y.side===x.side))recipients.push(x);
 }
 return recipients;
}
async function adjustBalance(memberId,position,side,delta){
 const right=side==="right"?delta:0,left=side==="left"?delta:0;
 const live=await db.query("SELECT member_id FROM network_bv_balances WHERE member_id=$1 AND account_position=$2 LIMIT 1",[memberId,position]);
 if(!live.rows.length){
   const legacy=await db.query(`SELECT s.payload FROM legacy_import_source_records s
     LEFT JOIN app_profiles p ON (NULLIF(s.payload->>'id','') IS NOT NULL AND p.legacy_member_code=s.payload->>'id')
       OR (NULLIF(s.payload->>'email','') IS NOT NULL AND lower(COALESCE(p.email,''))=lower(s.payload->>'email'))
     WHERE s.collection_name='agents' AND (s.source_id=$1 OR p.id=$1)
     ORDER BY CASE WHEN s.source_id=$1 THEN 0 WHEN p.legacy_member_code=s.payload->>'id' THEN 1 ELSE 2 END LIMIT 1`,[memberId]);
   const lp=legacy.rows[0]?.payload||{},suffix=position===1?"":String(position);
   const rightKey="rightPv"+suffix,leftKey="leftPv"+suffix,crKey="carryRight"+suffix,clKey="carryLeft"+suffix;
   await db.query(`INSERT INTO network_bv_balances(member_id,account_position,total_right,total_left,carry_right,carry_left,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,now()) ON CONFLICT(member_id,account_position) DO NOTHING`,
     [memberId,position,Number(lp[rightKey]||0),Number(lp[leftKey]||0),Number(lp[crKey]||0),Number(lp[clKey]||0)]);
 }
 await db.query(`UPDATE network_bv_balances SET total_right=GREATEST(0,total_right+$3),
   total_left=GREATEST(0,total_left+$4),updated_at=now() WHERE member_id=$1 AND account_position=$2`,
   [memberId,position,right,left]);
}
async function addRealBv(id,position,side,bv,actor){
 const saleId="ADMIN-"+crypto.randomUUID(),recipients=await getBvRecipients(id,position,side);
 for(const x of recipients){
   await db.query("INSERT INTO network_bv_ledger(order_id,source_member_id,upline_member_id,account_position,side,bv,sale_at) VALUES($1,$2,$3,$4,$5,$6,now()) ON CONFLICT(order_id,upline_member_id,account_position,side) DO NOTHING",[saleId,id,x.upline_member_id,x.account_position,x.side,bv]);
   await adjustBalance(x.upline_member_id,x.account_position,x.side,bv);
 }
 await db.query("INSERT INTO admin_manual_bv_sales(marketer_id,account_position,side,bv,mode,created_by) VALUES($1,$2,$3,$4,'real',$5)",[id,position,side,bv,actor]);
 return {sale_id:saleId,affected_uplines:Math.max(0,recipients.length-1),affected_accounts:recipients.length};
}
async function deleteRealBv(id,position,side,bv,actor){
 const available=await db.query(`SELECT order_id,bv,sale_at FROM network_bv_ledger
   WHERE source_member_id=$1 AND upline_member_id=$1 AND account_position=$2 AND side=$3 AND order_id LIKE 'ADMIN-%'
   ORDER BY sale_at DESC,created_at DESC`,[id,position,side]);
 const total=available.rows.reduce((n,r)=>n+Number(r.bv||0),0);
 if(total<bv)return {error:"insufficient_manual_bv",available:total};
 let remaining=bv,affected=new Map(),reversedSales=[];
 for(const sale of available.rows){
   if(remaining<=0)break;
   const current=Number(sale.bv||0),take=Math.min(current,remaining);
   const rows=await db.query("SELECT upline_member_id,account_position,side FROM network_bv_ledger WHERE order_id=$1 AND source_member_id=$2",[sale.order_id,id]);
   for(const row of rows.rows){
     const key=[row.upline_member_id,row.account_position,row.side].join("|");
     affected.set(key,{memberId:row.upline_member_id,position:Number(row.account_position),side:row.side,amount:(affected.get(key)?.amount||0)+take});
   }
   if(current===take)await db.query("DELETE FROM network_bv_ledger WHERE order_id=$1 AND source_member_id=$2",[sale.order_id,id]);
   else await db.query("UPDATE network_bv_ledger SET bv=bv-$3 WHERE order_id=$1 AND source_member_id=$2",[sale.order_id,id,take]);
   reversedSales.push(sale.order_id);remaining-=take;
 }
 for(const x of affected.values())await adjustBalance(x.memberId,x.position,x.side,-x.amount);
 await audit(actor,"manual_bv_delete",id,{bv,position,side,reversed_sales:reversedSales,affected_accounts:affected.size});
 return {deleted_bv:bv,affected_uplines:Math.max(0,affected.size-1),affected_accounts:affected.size};
}

export default async function(req,res){if(!(await requireAdminSession(req,res)))return;
 const actor=req.user?.id||null;
 if(req.method==="GET"){
  const q=clean(req.query?.q),page=Math.max(1,Number(req.query?.page||1)),limit=20,offset=(page-1)*limit,showDeleted=String(req.query?.deleted||"")!=="";
  const where="a.role='marketer'"+(showDeleted?"":" AND a.deleted_at IS NULL");
  const filter=q?" AND (a.display_name ILIKE $1 OR a.id ILIKE $1 OR a.phone ILIKE $1 OR a.referral_code ILIKE $1)":"";
  const base=q?["%"+q+"%"]:[];
  const count=await db.query("SELECT count(*)::int n FROM app_profiles a WHERE "+where+filter,base);
  const params=q?["%"+q+"%",limit,offset]:[limit,offset],lp=q?2:1,op=q?3:2;
  const rows=await db.query(`SELECT a.id,a.display_name,a.phone,a.referral_code,a.status,a.deleted_at,a.login_blocked,a.activation_blocked,a.activation_started_at,a.admin_tier_override,a.created_at,
  (SELECT naa.id FROM network_agent_applications naa WHERE naa.member_id=a.id AND naa.status='joined' ORDER BY naa.joined_at DESC NULLS LAST,naa.created_at DESC LIMIT 1) AS welcome_application_id,
  COALESCE((SELECT naa.welcome_email_status FROM network_agent_applications naa WHERE naa.member_id=a.id AND naa.status='joined' ORDER BY naa.joined_at DESC NULLS LAST,naa.created_at DESC LIMIT 1),'not_sent') AS welcome_email_status,
  get_admin_marketer_wallet_balance(a.id::text)::numeric AS wallet,COALESCE(s.qualified_sales,0)::int qualified_sales,COALESCE((SELECT count(*) FROM network_placements np WHERE np.owner_marketer_id=a.id),0)::int team_count FROM app_profiles a LEFT JOIN network_sales_qualification s ON s.marketer_id=a.id WHERE ${where}${filter} ORDER BY a.created_at ASC NULLS FIRST, a.id ASC LIMIT $${lp} OFFSET $${op}`,params);
  return res.json({ok:true,page,limit,total:count.rows[0].n,pages:Math.max(1,Math.ceil(count.rows[0].n/limit)),marketers:rows.rows});
 }
 const b=body(req),action=clean(b.action),id=clean(b.marketer_id);
 if(!id)return res.status(400).json({error:"missing_marketer_id"});
 if(action==="delete"||action==="restore"){await db.query("UPDATE app_profiles SET deleted_at=$2,status=$3 WHERE id=$1",[id,action==="delete"?new Date():null,action==="delete"?"deleted":"active"]);await audit(actor,action,id);return res.json({ok:true});}
 if(["block","unblock"].includes(action)){await db.query("UPDATE app_profiles SET status=$2 WHERE id=$1",[id,action==="block"?"blocked":"active"]);await audit(actor,action,id);return res.json({ok:true});}
 if(["login_block","login_unblock"].includes(action)){await db.query("UPDATE app_profiles SET login_blocked=$2 WHERE id=$1",[id,action==="login_block"]);await audit(actor,action,id);return res.json({ok:true});}
 if(["activation_block","activation_unblock"].includes(action)){await db.query("UPDATE app_profiles SET activation_blocked=$2 WHERE id=$1",[id,action==="activation_block"]);await audit(actor,action,id);return res.json({ok:true});}
 if(action==="full_block"){await db.query("UPDATE app_profiles SET status='blocked',login_blocked=true,activation_blocked=true WHERE id=$1",[id]);await db.query("DELETE FROM network_auth_sessions WHERE user_id=$1",[id]).catch(()=>{});await audit(actor,"full_block",id,{login_blocked:true,activation_blocked:true,bv_receiving_blocked:true});return res.json({ok:true,full_blocked:true});}
 if(action==="full_unblock"){await db.query("UPDATE app_profiles SET status='active',login_blocked=false,activation_blocked=false WHERE id=$1",[id]);await audit(actor,"full_unblock",id);return res.json({ok:true,full_blocked:false});}
 if(action==="withdrawal_status"){
  const wid=clean(b.withdrawal_id),status=clean(b.status).toLowerCase(),reason=clean(b.reason);
  if(!wid)return res.status(400).json({error:"missing_withdrawal_id"});
  if(!["pending","completed","rejected","cancelled"].includes(status))return res.status(400).json({error:"invalid_withdrawal_status"});
  if(status==="rejected"||status==="cancelled"){
   if(!reason.trim())return res.status(400).json({error:"rejection_reason_required"});
  }
  // SECURITY DEFINER function performs the status change and wallet debit atomically,
  // and can access the request even when ordinary RLS hides it from the admin API session.
  const result=await db.query("SELECT admin_set_network_withdrawal_status($1::uuid,$2,$3,$4,$5) AS result",[wid,id,status,reason,actor]);
  let outcome=result.rows[0]?.result||{};
  if(typeof outcome==="string"){try{outcome=JSON.parse(outcome)}catch{outcome={ok:false,error:"withdrawal_update_failed"}}}
  if(!outcome.ok){
   const code=outcome.error||"withdrawal_update_failed";
   const http=code==="withdrawal_not_found"?404:code==="insufficient_wallet_balance"?400:code==="completed_withdrawal_cannot_be_reopened"?409:400;
   return res.status(http).json({error:code,available_balance:outcome.available_balance});
  }
  return res.json({ok:true,status:outcome.status||status,already_completed:!!outcome.already_completed,amount:Number(outcome.amount||0)});
 }
 if(action==="edit"){
  if(Object.prototype.hasOwnProperty.call(b,"referral_code")){const code=clean(b.referral_code);if(!/^TO[a-z0-9]{5}$/i.test(code))return res.status(400).json({error:"invalid_marketer_id_format"});b.referral_code="TO"+code.slice(2).toLowerCase();}
  const fields=["display_name","phone","referral_code","first_name","second_name","third_name","fourth_name","national_id","email","country","state","city","heir_name","heir_mother_name","sponsor_id"];
  const sets=[],vals=[id]; for(const f of fields)if(Object.prototype.hasOwnProperty.call(b,f)){sets.push(f+"=$"+(vals.length+1));vals.push(clean(b[f])||null);}
  if(sets.length){await db.query("UPDATE app_profiles SET "+sets.join(",")+" WHERE id=$1",vals);}
  const appFields=["first_name","second_name","third_name","fourth_name","national_id","phone","email","country","state","city","heir_name","heir_mother_name","referral_id"];
  const aSets=[],aVals=[id]; for(const f of appFields)if(Object.prototype.hasOwnProperty.call(b,f)){aSets.push(f+"=$"+(aVals.length+1));aVals.push(clean(b[f])||null);}
  if(aSets.length)await db.query("UPDATE network_agent_applications SET "+aSets.join(",")+" WHERE member_id=$1",aVals);
  await audit(actor,"edit",id); return res.json({ok:true});
 }
 if(action==="password"){
  const pw=String(b.password||""); if(pw.length<6)return res.status(400).json({error:"password_too_short"});
  const h=hash(pw);
  if(b.kind==="wallet"){await db.query("UPDATE app_profiles SET wallet_password_hash=$2 WHERE id=$1",[id,h]);await db.query("UPDATE network_agent_applications SET wallet_password_hash=$2 WHERE member_id=$1",[id,h]).catch(()=>{});}
  else {await db.query("UPDATE app_profiles SET login_password_hash=$2 WHERE id=$1",[id,h]);await db.query("UPDATE network_agent_applications SET password_hash=$2 WHERE member_id=$1",[id,h]).catch(()=>{});await db.query("DELETE FROM network_auth_sessions WHERE user_id=$1",[id]).catch(()=>{});}
  await audit(actor,"change_"+(b.kind==="wallet"?"wallet":"login")+"_password",id); return res.json({ok:true});
 }
 if(action==="wallet_reconcile"){
  // Rebuild the spendable wallet from the admin adjustment history; recovery refs make this idempotent.
  const exists=await db.query("SELECT id FROM app_profiles WHERE id=$1 AND role='marketer' LIMIT 1",[id]);
  if(!exists.rows.length)return res.status(404).json({error:"marketer_not_found"});
  const sum=await db.query("SELECT COALESCE(SUM(CASE WHEN action='remove' THEN -ABS(amount) ELSE ABS(amount) END),0)::numeric AS balance FROM admin_manual_wallet_actions WHERE marketer_id=$1",[id]);
  const target=Number(sum.rows[0]?.balance||0);
  await db.query("SELECT admin_set_marketer_wallet_balance($1,$2) AS balance",[id,target]);
  // Recovery transaction rows are inserted inside admin_set_marketer_wallet_balance() under the correct RLS context.
  await audit(actor,"wallet_reconcile",id,{balance:target});
  return res.json({ok:true,balance:target});
 }
 if(action==="wallet"){
  const amount=Number(b.amount); if(!(amount>0))return res.status(400).json({error:"invalid_amount"});
  const mode=b.mode==="remove"?"remove":"add",delta=mode==="remove"?-Math.abs(amount):Math.abs(amount);
  const adjusted=await db.query("SELECT admin_adjust_marketer_wallet($1,$2,$3,$4,$5) AS balance",[id,delta,mode,actor,"admin:"+actor]);
  if(adjusted.rows[0]?.balance===null||adjusted.rows[0]?.balance===undefined)return res.status(400).json({error:"insufficient_wallet_balance"});
  await audit(actor,"wallet_"+mode,id,{amount}); return res.json({ok:true});
 }
 if(action==="manual_bv_delete"){
  const bv=Number(b.bv),position=Number(b.account_position||1),side=clean(b.side||"right");
  if(!Number.isSafeInteger(bv)||!(bv>0)||![1,2,3].includes(position)||!["left","right"].includes(side))return res.status(400).json({error:"invalid_bv"});
  const result=await deleteRealBv(id,position,side,bv,actor);
  if(result.error==="insufficient_manual_bv")return res.status(400).json({error:"insufficient_manual_bv",available:result.available,message:"قيمة الحذف أكبر من الـBV اليدوي المتاح في هذا الاتجاه والحساب."});
  return res.json({ok:true,...result});
 }
 if(action==="manual_bv"){
  const bv=Number(b.bv),position=Number(b.account_position||1),side=clean(b.side||"right"),mode=clean(b.mode||"display");
  if(!Number.isSafeInteger(bv)||!(bv>0)||![1,2,3].includes(position)||!["left","right"].includes(side))return res.status(400).json({error:"invalid_bv"});
  let result={affected_uplines:0};
  if(mode==="real"){
   result=await addRealBv(id,position,side,bv,actor);
  }else{
   await db.query("UPDATE app_profiles SET admin_tier_override=$2,activation_started_at=COALESCE(activation_started_at,now()) WHERE id=$1",[id,position]);
   await audit(actor,"manual_bv_activation_only",id,{position,side,bv});
   return res.json({ok:true,mode:"activation_only",level:position,affected_uplines:0});
  }
  await audit(actor,"manual_bv",id,{bv,position,side,mode}); return res.json({ok:true,...result});
 }
 if(action==="activate"){const level=Math.max(0,Math.min(3,Number(b.level||0)));await db.query("UPDATE app_profiles SET admin_tier_override=$2,activation_started_at=CASE WHEN $2>0 THEN COALESCE(activation_started_at,now()) ELSE NULL END WHERE id=$1",[id,level]);await audit(actor,"activate",id,{level});return res.json({ok:true,level,activation_started_at:level>0?"set":"cleared"});}
 return res.status(400).json({error:"unknown_action"});
}