import { db } from "hatchable";
import crypto from "node:crypto";
import { requireNetworkUser } from "../../lib/network-auth.js";

export const access = "public";
export const methods = ["GET", "POST"];

const bodyOf = req => typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
const sha = value => crypto.createHash("sha256").update(String(value || "")).digest("hex");
const fullName = p => [p.first_name,p.second_name,p.third_name,p.fourth_name].filter(Boolean).join(" ").trim() || p.display_name || "";

async function profileFor(uid) {
  const r = await db.query("SELECT id,role,status,deleted_at,login_blocked,activation_blocked,display_name,first_name,second_name,third_name,fourth_name,phone,wallet_password_hash FROM app_profiles WHERE id=$1 LIMIT 1",[uid]);
  if(!r.rows[0]) return null;
  const legacy = await db.query("SELECT wallet_password_hash FROM network_agent_applications WHERE member_id=$1 ORDER BY created_at DESC LIMIT 1",[uid]).catch(()=>({rows:[]}));
  r.rows[0].wallet_password_hashes = [r.rows[0].wallet_password_hash,...legacy.rows.map(x=>x.wallet_password_hash)].filter(Boolean);
  return r.rows[0];
}
async function balanceFor(uid) {
  const [wallet,tx,admin] = await Promise.all([
    db.query("SELECT COALESCE(balance,0)::numeric AS balance FROM wallets WHERE user_id=$1",[uid]),
    db.query("SELECT COUNT(*)::int AS n FROM wallet_transactions WHERE user_id=$1",[uid]),
    db.query("SELECT COALESCE(SUM(CASE WHEN action='remove' THEN -ABS(amount) ELSE ABS(amount) END),0)::numeric AS net FROM admin_manual_wallet_actions WHERE marketer_id=$1",[uid])
  ]);
  return wallet.rows.length && (Number(wallet.rows[0].balance||0)!==0 || Number(tx.rows[0]?.n||0)>0)
    ? Number(wallet.rows[0].balance||0) : Number(admin.rows[0]?.net||0);
}
async function checkState(uid) {
  const r=await db.query("SELECT settled_at,check_amount FROM network_bv_settlements WHERE member_id=$1 AND check_amount>0 ORDER BY settled_at DESC LIMIT 1",[uid]);
  if(!r.rows.length) return {eligible:false,latest:null};
  const latest=new Date(r.rows[0].settled_at);
  return {eligible:Number.isFinite(latest.getTime()) && Date.now()-latest.getTime()>=3*24*60*60*1000,latest:r.rows[0].settled_at};
}
async function member(req,res) {
  const user=await requireNetworkUser(req,res); if(!user)return null;
  const p=await profileFor(user.id);
  if(!p || p.role!=="marketer") {res.status(403).json({ok:false,error:"marketer_only"});return null;}
  if(p.deleted_at || p.login_blocked || ["blocked","deleted","terminated","termination","terminated_permanent","terminated_temporary"].includes(String(p.status||"").toLowerCase())) {res.status(403).json({ok:false,error:"account_restricted"});return null;}
  return {user,p};
}
export default async function handler(req,res) {
  const auth=await member(req,res); if(!auth)return;
  const {user,p}=auth, uid=user.id;
  if(req.method==="GET") {
    const [balance,check,requests,pending] = await Promise.all([
      balanceFor(uid),
      checkState(uid),
      db.query("SELECT id,amount,status,note,full_name,transfer_phone,created_at FROM withdrawal_requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100",[uid]),
      db.query("SELECT COALESCE(SUM(amount),0)::numeric AS total FROM withdrawal_requests WHERE user_id=$1 AND lower(status) IN ('pending','قيد الانتظار','under_review')",[uid])
    ]);
    return res.json({ok:true,account:{name:fullName(p),phone:p.phone||""},balance,available_balance:Math.max(0,balance-Number(pending.rows[0]?.total||0)),latest_check_at:check.latest,check_eligible:check.eligible,requests:requests.rows.map(x=>({...x,amount:Number(x.amount||0)}))});
  }
  if(req.method!=="POST") return res.status(405).json({ok:false,error:"method_not_allowed"});
  let b; try{b=bodyOf(req)}catch{return res.status(400).json({ok:false,error:"invalid_json"});}
  const name=String(b.full_name||"").trim(), phone=String(b.transfer_phone||"").trim(), pin=String(b.wallet_pin||"").trim();
  const amount=Number(String(b.amount??"").replace(/,/g,""));
  if(name.length<5) return res.status(400).json({ok:false,error:"name_required"});
  if(!Number.isFinite(amount)||amount<=0||Math.round(amount*100)!==amount*100) return res.status(400).json({ok:false,error:"invalid_amount"});
  if(!/^[0-9٠-٩۰-۹+()\s-]{8,25}$/.test(phone)) return res.status(400).json({ok:false,error:"invalid_phone"});
  if(!pin) return res.status(400).json({ok:false,error:"wallet_pin_required"});
  const suppliedHash=sha(pin); const knownHashes=p.wallet_password_hashes||[p.wallet_password_hash].filter(Boolean);
  if(!knownHashes.some(saved=>suppliedHash===String(saved))) return res.status(400).json({ok:false,error:"invalid_wallet_pin"});
  const check=await checkState(uid);
  if(!check.latest || !check.eligible) return res.status(400).json({ok:false,error:"check_review_period",latest_check_at:check.latest});
  const current=await balanceFor(uid);
  const reserved=await db.query("SELECT COALESCE(SUM(amount),0)::numeric AS total FROM withdrawal_requests WHERE user_id=$1 AND lower(status) IN ('pending','قيد الانتظار','under_review')",[uid]);
  const available=current-Number(reserved.rows[0]?.total||0);
  if(amount>available) return res.status(400).json({ok:false,error:"insufficient_balance",available_balance:Math.max(0,available)});
  const ins=await db.query("INSERT INTO withdrawal_requests(user_id,amount,status,note,full_name,transfer_phone) VALUES($1,$2,'pending',NULL,$3,$4) RETURNING id,amount,status,full_name,transfer_phone,created_at",[uid,amount,name,phone]);
  return res.status(201).json({ok:true,message:"withdrawal_submitted",request:{...ins.rows[0],amount:Number(ins.rows[0].amount||0)},available_balance:Math.max(0,available-amount)});
}