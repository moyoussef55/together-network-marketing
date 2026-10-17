import { runNetworkUpdate } from "../../lib/network-update.js";
export const methods=["POST"];
export const access="scheduler";
export default async function(req,res){
  if(req.headers["x-hatchable-trigger"]!=="cron")return res.status(403).json({error:"scheduler_only"});
  const result=await runNetworkUpdate({manual:false});
  return res.json(result);
}