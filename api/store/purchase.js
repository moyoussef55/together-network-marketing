import { db } from "hatchable";
import { requireNetworkUser } from "../../lib/network-auth.js";
export const access="public";
export const methods=["POST"];
export default async function(req,res){
 const user=await requireNetworkUser(req,res);
 if(!user)return;
 const uid=user.id;
 const p=await db.query("SELECT role,deleted_at,login_blocked FROM app_profiles WHERE id=$1",[uid]);
 if(!p.rows.length||p.rows[0].role!=="marketer"||p.rows[0].deleted_at||p.rows[0].login_blocked)return res.status(403).json({error:"marketer_only"});
 return res.status(501).json({error:"purchase_not_ready"});
}