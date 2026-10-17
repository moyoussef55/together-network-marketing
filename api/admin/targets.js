import { db } from "hatchable";
import { requireAdminSession } from "../../lib/admin-auth.js";
import crypto from "node:crypto";
export const access = "public";
export const methods = ["GET","POST","DELETE"];
export default async function(req,res){
  if(!(await requireAdminSession(req,res))) return;
  try {
    if(req.method==="GET"){
      const r=await db.query("SELECT entity_id AS id, metadata->>'title' AS title, metadata->>'description' AS description, COALESCE((metadata->>'reward_amount')::numeric,0) AS reward_amount, created_at FROM audit_logs WHERE action='network_target_published' ORDER BY created_at DESC");
      return res.json({ok:true,targets:r.rows});
    }
    const b=typeof req.body==="string"?JSON.parse(req.body||"{}"):(req.body||{});
    if(req.method==="DELETE"){
      const id=String(b.id||"").trim();
      if(!id||id.length>100)return res.status(400).json({ok:false,error:"target_id_required"});
      const r=await db.query("DELETE FROM audit_logs WHERE action='network_target_published' AND entity_id=$1 RETURNING entity_id",[id]);
      if(!r.rows.length)return res.status(404).json({ok:false,error:"target_not_found"});
      return res.json({ok:true});
    }
    const title=String(b.title||"").trim(),description=String(b.description||"").trim(),reward=Number(b.reward_amount);
    if(!title||title.length>180)return res.status(400).json({ok:false,error:"title_required_or_too_long"});
    if(!description||description.length>5000)return res.status(400).json({ok:false,error:"description_required_or_too_long"});
    if(!Number.isFinite(reward)||reward<0||reward>100000000)return res.status(400).json({ok:false,error:"invalid_reward_amount"});
    const id=crypto.randomUUID(),metadata={title,description,reward_amount:reward,published:true};
    const r=await db.query("INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,'network_target_published','network_target',$2,$3::jsonb) RETURNING created_at",[ "admin", id, JSON.stringify(metadata)]);
    return res.status(201).json({ok:true,target:{id,title,description,reward_amount:reward,published:true,created_at:r.rows[0].created_at}});
  }catch(e){console.error("admin targets failed",e);return res.status(500).json({ok:false,error:"targets_operation_failed"});}
}