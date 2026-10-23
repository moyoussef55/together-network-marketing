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
  // Use the same scoped wallet-state function as the marketer wallet page.
  // Direct reads of wallets/wallet_transactions can be hidden by row-level policies,
  // incorrectly making a funded account look empty during withdrawal validation.
  let storedBalance = 0;
  let foundWallet = false;
  try {
    const scoped = await db.query("SELECT get_marketer_wallet_state($1) AS state",[uid]);
    let state=scoped.rows[0]?.state||{};
    if(typeof state==="string"){try{state=JSON.parse(state)}catch{state={}}}
    if(state.wallet_found){storedBalance=Number(state.balance||0);foundWallet=true;}
  } catch {}
  if(!foundWallet){
    const [wallet,tx,admin] = await Promise.all([
      db.query("SELECT COALESCE(balance,0)::numeric AS balance FROM wallets WHERE user_id=$1",[uid]),
      db.query("SELECT COUNT(*)::int AS n FROM wallet_transactions WHERE user_id=$1",[uid]),
      db.query("SELECT COALESCE(SUM(CASE WHEN action='remove' THEN -ABS(amount) ELSE ABS(amount) END),0)::numeric AS net FROM admin_manual_wallet_actions WHERE marketer_id=$1",[uid])
    ]);
    storedBalance = wallet.rows.length && (Number(wallet.rows[0].balance||0)!==0 || Number(tx.rows[0]?.n||0)>0)
      ? Number(wallet.rows[0].balance||0) : Number(admin.rows[0]?.net||0);
  }
  // Paid weekly checks already live in wallets.balance; settlement totals must not be added again.
  return storedBalance;
}
async function checkState(uid) {
  const r=await db.query("SELECT settled_at,check_amount FROM network_bv_settlements WHERE member_id=$1 AND check_amount>0 ORDER BY settled_at DESC LIMIT 1",[uid]);
  if(!r.rows.length) return {eligible:false,latest:null};
  const latest=new Date(r.rows[0].settled_at);
  return {eligible:Number.isFinite(latest.getTime()) && Date.now()-latest.getTime()>=3*24*60*60*1000,latest:r.rows[0].settled_at};
}
async function requestsFor(uid) {
  // Use the SECURITY DEFINER helper because row-level policies can hide the member's
  // own withdrawal rows when the app uses its custom network session.
  const r=await db.query("SELECT get_network_withdrawal_requests($1) AS requests",[uid]);
  let rows=r.rows[0]?.requests||[];
  if(typeof rows==="string"){try{rows=JSON.parse(rows)}catch{rows=[]}}
  return Array.isArray(rows)?rows:[];
}
const isPendingStatus=s=>["pending","قيد الانتظار","under_review","in_review","processing","جاري المراجعة","قيد المراجعة"].includes(String(s||"").trim().toLowerCase());
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
    const [balance,check,requests] = await Promise.all([
      balanceFor(uid),
      checkState(uid),
      requestsFor(uid)
    ]);
    const reserved=requests.filter(x=>isPendingStatus(x.status)).reduce((sum,x)=>sum+Number(x.amount||0),0);
    return res.json({ok:true,account:{name:fullName(p),phone:p.phone||""},balance:Math.max(0,balance-reserved),available_balance:Math.max(0,balance-reserved),latest_check_at:check.latest,check_eligible:check.eligible,requests:requests.map(x=>({...x,amount:Number(x.amount||0)}))});
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
  const existingRequests=await requestsFor(uid);
  const reserved=existingRequests.filter(x=>isPendingStatus(x.status)).reduce((sum,x)=>sum+Number(x.amount||0),0);
  const available=current-reserved;
  if(amount>available) return res.status(400).json({ok:false,error:"insufficient_balance",available_balance:Math.max(0,available)});
  const ins=await db.query("SELECT submit_network_withdrawal($1,$2,$3,$4) AS request",[uid,amount,name,phone]);
  let request=ins.rows[0]?.request||{};
  if(typeof request==="string"){try{request=JSON.parse(request)}catch{request={}}}
  if(!request.id) throw new Error("withdrawal_insert_failed");
  return res.status(201).json({ok:true,message:"withdrawal_submitted",request:{...request,amount:Number(request.amount||0)},available_balance:Math.max(0,available-amount)});
}