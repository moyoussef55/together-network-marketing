import { db } from "hatchable";
import { runNetworkUpdate } from "../../lib/network-update.js";
import { requireAdminSession } from "../../lib/admin-auth.js";
export const access = "public";
export const methods=["GET","POST"];
export default async function(req,res){if(!(await requireAdminSession(req,res)))return;
  if(req.method==="GET"){
    const r=await db.query("SELECT name,level,rate,active FROM commission_rules WHERE name IN ('direct_commission_amount','weekly_check_amount','automatic_update_enabled')");
    const s=Object.fromEntries(r.rows.map(x=>[x.name,x.name==="automatic_update_enabled"?Number(x.rate):Number(x.level)]));
    return res.json({ok:true,direct_commission_amount:s.direct_commission_amount??250,weekly_check_amount:s.weekly_check_amount??1500,automatic_update_enabled:(s.automatic_update_enabled??1)===1,timezone:"Africa/Cairo",next_run:"الجمعة 12:00 منتصف الليل (بداية السبت)"});
  }
  let b=req.body||{}; if(typeof b==="string"){try{b=JSON.parse(b)}catch{return res.status(400).json({ok:false,error:"invalid_json"})}}
  const action=String(b.action||"");
  if(action==="direct_commission"){
    const direct=Number(b.direct_commission_amount);
    if(!Number.isInteger(direct)||direct<0||direct>100000)return res.status(400).json({ok:false,error:"invalid_amount"});
    await db.query("INSERT INTO commission_rules(id,name,level,rate,active) VALUES(gen_random_uuid(),'direct_commission_amount',$1,0,true) ON CONFLICT(name) DO UPDATE SET level=EXCLUDED.level,active=true",[direct]);
    await db.query("UPDATE network_direct_commissions SET amount=$1 WHERE status='pending'",[direct]);
    return res.json({ok:true,saved:true,direct_commission_amount:direct,updated_pending_commissions:true});
  }
  if(action==="weekly_check"){
    const check=Number(b.weekly_check_amount);
    if(!Number.isInteger(check)||check<0||check>100000)return res.status(400).json({ok:false,error:"invalid_amount"});
    await db.query("INSERT INTO commission_rules(id,name,level,rate,active) VALUES(gen_random_uuid(),'weekly_check_amount',$1,0,true) ON CONFLICT(name) DO UPDATE SET level=EXCLUDED.level,active=true",[check]);
    return res.json({ok:true,saved:true,weekly_check_amount:check});
  }
  if(action==="settings"){
    const direct=Number(b.direct_commission_amount),check=Number(b.weekly_check_amount);
    if(!Number.isInteger(direct)||direct<0||direct>100000||!Number.isInteger(check)||check<0||check>100000)return res.status(400).json({ok:false,error:"invalid_amount"});
    await db.query("INSERT INTO commission_rules(id,name,level,rate,active) VALUES(gen_random_uuid(),'direct_commission_amount',$1,0,true) ON CONFLICT(name) DO UPDATE SET level=EXCLUDED.level,active=true",[direct]);
    await db.query("INSERT INTO commission_rules(id,name,level,rate,active) VALUES(gen_random_uuid(),'weekly_check_amount',$1,0,true) ON CONFLICT(name) DO UPDATE SET level=EXCLUDED.level,active=true",[check]);
    await db.query("UPDATE network_direct_commissions SET amount=$1 WHERE status='pending'",[direct]);
    return res.json({ok:true,saved:true,direct_commission_amount:direct,weekly_check_amount:check,updated_pending_commissions:true});
  }
  if(action==="automatic"){
    const enabled=!!b.enabled;
    await db.query("UPDATE commission_rules SET rate=$1,active=true WHERE name='automatic_update_enabled'",[enabled?1:0]);
    return res.json({ok:true,automatic_update_enabled:enabled});
  }
  if(action==="manual"){
    const result=await runNetworkUpdate({manual:true});
    return res.json(result);
  }
  return res.status(400).json({ok:false,error:"unknown_action"});
}