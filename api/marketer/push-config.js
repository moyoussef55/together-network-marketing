import { config, db } from "hatchable";
import { requireNetworkUser } from "../../lib/network-auth.js";
export const access = "public";
export const methods = ["GET"];
export default async function(req,res){
 const user=await requireNetworkUser(req,res);if(!user)return;
 const p=await db.query("SELECT role,deleted_at,login_blocked,status FROM app_profiles WHERE id=$1 LIMIT 1",[user.id]);
 const row=p.rows[0];
 if(!row||row.role!=="marketer"||row.deleted_at||row.login_blocked||["blocked","deleted"].includes(String(row.status||"").toLowerCase()))return res.status(403).json({error:"account_unavailable"});
 let appId="";
 try{appId=String(await config.get("ONESIGNAL_APP_ID")||"").trim()}catch{}
 return res.json({ok:true,app_id:appId,user_id:String(user.id),configured:Boolean(appId)});
}