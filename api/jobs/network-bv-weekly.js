import { db } from "hatchable";
import { runNetworkUpdate } from "../../lib/network-update.js";
export const methods=["POST"];
export const access="scheduler";
export default async function(req,res){
  if(req.headers["x-hatchable-trigger"]!=="cron")return res.status(403).json({error:"scheduler_only"});
  const result=await runNetworkUpdate({manual:false});
  if(result && result.ok && !result.skipped && result.settlement && result.settlement.settled){
    try{
      await db.query(
        "INSERT INTO admin_auto_update_notifications(week_start,week_end,payload) VALUES($1::date,$2::date,$3::jsonb) ON CONFLICT(week_start,week_end) DO NOTHING",
        [result.settlement.week_start,result.settlement.week_end,JSON.stringify(result)]
      );
      result.notification_saved=true;
    }catch(e){
      result.notification_saved=false;
    }
  }
  return res.json(result);
}