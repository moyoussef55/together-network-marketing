import { db } from "hatchable";
import { requireAdminSession } from "../../lib/admin-auth.js";
export const access = "public";
export const methods = ["GET","POST"];

function makeCode(){
  return "IBN-"+crypto.randomUUID().replaceAll("-","").slice(0,20).toUpperCase();
}

export default async function(req,res){if(!(await requireAdminSession(req,res)))return;
  if(req.method==="GET"){
    const q=String(req.query?.search||req.url?.split("?search=")[1]||"").trim();
    const values=[];
    let where="";
    if(q){
      values.push("%"+q+"%");
      where=`WHERE i.code ILIKE $1
        OR COALESCE(i.created_by_id,'') ILIKE $1
        OR COALESCE(i.used_by_upline_id,'') ILIKE $1
        OR COALESCE(i.registered_agent_id,'') ILIKE $1
        OR COALESCE(registered.display_name,'') ILIKE $1
        OR COALESCE(registered.referral_code,'') ILIKE $1
        OR COALESCE(upline.display_name,'') ILIKE $1
        OR COALESCE(upline.referral_code,'') ILIKE $1`;
    }
    const rows=await db.query(`SELECT i.id,i.code,i.amount,i.quantity,i.expires_at,i.used_count,i.active,
        i.created_at,i.created_by_id,i.used_by_upline_id,i.registered_agent_id,i.used_at,
        registered.display_name AS registered_marketer_name,
        registered.referral_code AS registered_marketer_code,
        upline.display_name AS upline_marketer_name,
        upline.referral_code AS upline_marketer_code
      FROM network_ibns i
      LEFT JOIN app_profiles registered ON registered.id::text=i.registered_agent_id
      LEFT JOIN app_profiles upline ON upline.id::text=i.used_by_upline_id
      ${where}
      ORDER BY i.used_at DESC NULLS LAST,i.created_at DESC LIMIT 500`,values);
    return res.json({ibns:rows.rows});
  }

  const b=typeof req.body==="string"?JSON.parse(req.body||"{}"):(req.body||{});
  const amount=Number(b.amount), quantity=Math.floor(Number(b.quantity)), expires=b.expires_at;
  const creatorId=req.user?.id||null;
  if(!(amount>0)||!(quantity>0)||quantity>10000||!expires){
    return res.status(400).json({error:"invalid_ibn"});
  }
  const expiry=new Date(expires);
  if(Number.isNaN(expiry.getTime())||expiry<=new Date()){
    return res.status(400).json({error:"invalid_expiry"});
  }

  const created=[];
  for(let i=0;i<quantity;i++){
    let code=makeCode();
    const r=await db.query(`INSERT INTO network_ibns
      (code,amount,quantity,expires_at,used_count,active,created_by_id)
      VALUES($1,$2,1,$3,0,true,$4)
      RETURNING id,code,amount,quantity,expires_at,created_at,created_by_id`,
      [code,amount,expiry.toISOString(),creatorId]);
    created.push(r.rows[0]);
  }
  return res.json({ok:true,message:"تمت الإضافة بنجاح",count:created.length,ibns:created});
}