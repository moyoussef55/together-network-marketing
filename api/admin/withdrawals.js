import { db } from "hatchable";
import { requireAdminSession } from "../../lib/admin-auth.js";
export const access = "public";
export const methods = ["GET"];

export default async function(req,res) { if(!(await requireAdminSession(req,res)))return;
  if(req.method!=="GET") return res.status(405).json({ok:false,error:"method_not_allowed"});
  const q=String(req.query?.q||"").trim();
  const status=String(req.query?.status||"all").trim().toLowerCase();
  const params=[];
  const where=[];
  if(status!=="all") {
    if(status==="pending") where.push("lower(w.status) IN ('pending','قيد الانتظار','under_review')");
    else if(status==="completed") where.push("lower(w.status) IN ('completed','complete','paid','approved','done')");
    else if(status==="cancelled") where.push("lower(w.status) IN ('cancelled','canceled','rejected','declined','مرفوض','ملغى','ملغي')");
  }
  if(q) {
    params.push("%"+q+"%");
    const n=params.length;
    where.push("(COALESCE(w.full_name,'') ILIKE $"+n+" OR COALESCE(w.transfer_phone,'') ILIKE $"+n+" OR COALESCE(a.display_name,'') ILIKE $"+n+" OR COALESCE(a.email,'') ILIKE $"+n+" OR COALESCE(a.phone,'') ILIKE $"+n+" OR COALESCE(a.referral_code,'') ILIKE $"+n+" OR w.id::text ILIKE $"+n+" OR w.user_id ILIKE $"+n+")");
  }
  // The admin session is checked above. Read through the narrowly scoped database
  // function because the normal table policy intentionally hides other members' rows.
  const result=await db.query("SELECT list_network_withdrawals_admin() AS requests");
  let all=result.rows[0]?.requests||[];
  if(typeof all==="string"){try{all=JSON.parse(all)}catch{all=[]}}
  if(!Array.isArray(all)) all=[];
  const pendingStatus=s=>["pending","قيد الانتظار","under_review"].includes(String(s||"").toLowerCase());
  const completedStatus=s=>["completed","complete","paid","approved","done"].includes(String(s||"").toLowerCase());
  const cancelledStatus=s=>["cancelled","canceled","rejected","declined","مرفوض","ملغى","ملغي"].includes(String(s||"").toLowerCase());
  const stats={total:all.length,pending:all.filter(x=>pendingStatus(x.status)).length,completed:all.filter(x=>completedStatus(x.status)).length,cancelled:all.filter(x=>cancelledStatus(x.status)).length};
  let filtered=all;
  if(status==="pending") filtered=filtered.filter(x=>pendingStatus(x.status));
  else if(status==="completed") filtered=filtered.filter(x=>completedStatus(x.status));
  else if(status==="cancelled") filtered=filtered.filter(x=>cancelledStatus(x.status));
  if(q){const needle=q.toLowerCase();filtered=filtered.filter(x=>[x.full_name,x.transfer_phone,x.display_name,x.email,x.marketer_phone,x.referral_code,x.id,x.user_id].some(v=>String(v||"").toLowerCase().includes(needle)))}
  filtered.sort((a,b)=>(pendingStatus(a.status)?0:1)-(pendingStatus(b.status)?0:1)||new Date(b.created_at||0)-new Date(a.created_at||0));
  return res.json({ok:true,requests:filtered.slice(0,500).map(x=>({...x,amount:Number(x.amount||0)})),stats});
}