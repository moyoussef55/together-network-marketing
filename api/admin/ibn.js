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
      where="WHERE code ILIKE $1 OR COALESCE(created_by_id,'') ILIKE $1 OR COALESCE(used_by_upline_id,'') ILIKE $1 OR COALESCE(registered_agent_id,'') ILIKE $1";
    }
    const rows=await db.query(`SELECT id,code,amount,quantity,expires_at,used_count,active,created_at,created_by_id,used_by_upline_id,registered_agent_id,used_at
      FROM network_ibns ${where} ORDER BY created_at DESC LIMIT 500`,values);
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