import { db } from "hatchable";
import { requireAdminSession } from "../../lib/admin-auth.js";

export const access = "public";
export const methods = ["GET"];

const UPLOAD_ID = "773fcb03-0b45-403d-b060-1d040175b4cc";

const idOf = v => v && typeof v === "object" ? String(v.$oid || v._id || "") : String(v || "");
const norm = v => String(v ?? "").trim().toLowerCase();
const num = v => {
  if (v == null || v === "") return 0;
  if (typeof v === "object") return Number(v.$numberLong ?? v.$numberInt ?? v.$numberDouble ?? v.$numberDecimal ?? 0) || 0;
  return Number(v) || 0;
};
const fields = rows => [...new Set((rows || []).flatMap(x => Object.keys(x || {}).filter(k => !/(password|secret|token|credential|national.?id|pin|code)/i.test(k))))].sort();
const sum = (rows, key) => (rows || []).reduce((a,x) => a + num(x?.[key]), 0);
const counts = (rows, key) => (rows || []).reduce((a,x) => { const k=String(x?.[key] ?? "(empty)").toLowerCase(); a[k]=(a[k]||0)+1; return a; },{});

export default async function(req,res) {
  if (!(await requireAdminSession(req,res))) return;
  try {
    const u = await db.query("SELECT id,filename,expected_bytes,expected_chunks,status,staged_at FROM local_migration_uploads WHERE id=$1 LIMIT 1",[UPLOAD_ID]);
    if (!u.rows.length) return res.status(404).json({ok:false,error:"staged_upload_not_found"});
    if (u.rows[0].status !== "staged") return res.status(409).json({ok:false,error:"upload_not_staged",status:u.rows[0].status});
    const c = await db.query("SELECT chunk_index,content FROM local_migration_upload_chunks WHERE upload_id=$1 ORDER BY chunk_index",[UPLOAD_ID]);
    if (c.rows.length !== Number(u.rows[0].expected_chunks)) return res.status(409).json({ok:false,error:"chunk_count_mismatch"});
    const raw = c.rows.map(x=>x.content).join("");
    if (raw.length !== Number(u.rows[0].expected_bytes)) return res.status(409).json({ok:false,error:"payload_length_mismatch"});
    const source = JSON.parse(raw);
    if (source.exportFormat !== "together-network-migration-v1") return res.status(400).json({ok:false,error:"unexpected_export_format"});

    const coll = source.collections || {};
    const agents = Array.isArray(coll.agents) ? coll.agents : [];
    const profilesQ = await db.query("SELECT id,email,legacy_member_code,referral_code FROM app_profiles WHERE role='marketer'");
    const profiles = profilesQ.rows;
    const byEmail = new Map(), byCode = new Map(), byId = new Map();
    const add = (m,k,id) => { k=norm(k); if(!k)return; if(!m.has(k))m.set(k,new Set()); m.get(k).add(String(id)); };
    for (const p of profiles) { add(byEmail,p.email,p.id); add(byCode,p.legacy_member_code,p.id); add(byCode,p.referral_code,p.id); add(byId,p.id,p.id); }
    let matched=0,unmatched=0,ambiguous=0,exact=0,code=0,email=0;
    const used = new Map();
    for (const a of agents) {
      const oid=idOf(a._id), memberCode=a.id, em=a.email;
      const candidateSets=[byId.get(norm(oid)),byCode.get(norm(memberCode)),byEmail.get(norm(em))].filter(Boolean);
      const ids=new Set(candidateSets.flatMap(s=>[...s]));
      if(ids.size===0){unmatched++;continue;}
      if(ids.size>1){ambiguous++;continue;}
      matched++;
      const target=[...ids][0]; used.set(target,(used.get(target)||0)+1);
      if(byId.has(norm(oid)))exact++; else if(byCode.has(norm(memberCode)))code++; else email++;
    }
    const dupTargets=[...used.values()].filter(v=>v>1).length;
    const collectionSummary={};
    for (const [k,v] of Object.entries(coll)) collectionSummary[k]={records:Array.isArray(v)?v.length:0,field_names:fields(v)};
    const bvh=coll.balancehistories||[], w=coll.withdraws||[], tr=coll.transferhistories||[], ah=coll.agenthistories||[], pins=coll.e_pins||[];
    const bvFields=["rightPv","leftPv","carryRight","carryLeft","rightPv2","leftPv2","carryRight2","carryLeft2","rightPv3","leftPv3","carryRight3","carryLeft3"];
    const bv={}; for(const f of bvFields) bv[f]={sum:sum(agents,f),nonzero:agents.filter(x=>num(x[f])!==0).length};
    return res.json({
      ok:true,mode:"read_only_preview",
      upload:{id:UPLOAD_ID,status:u.rows[0].status,filename:u.rows[0].filename,characters:raw.length,chunks:c.rows.length},
      source:{database:source.database,collections:collectionSummary},
      target:{marketers:profiles.length},
      matching:{source_marketers:agents.length,unique_matches:matched,exact_source_id:exact,member_code:code,email_only:email,unmatched,ambiguous,multiple_source_records_for_same_target:dupTargets},
      balances:{source_wallet_total:sum(agents,"balance"),nonzero_wallets:agents.filter(x=>num(x.balance)!==0).length},
      bv,
      history:{agent_history_records:ah.length,balance_history_records:bvh.length,balance_history_value_total:sum(bvh,"value"),balance_history_statuses:counts(bvh,"status"),withdrawal_records:w.length,withdrawal_total:sum(w,"request"),withdrawal_statuses:counts(w,"status"),transfer_records:tr.length,transfer_total:sum(tr,"request"),e_pin_records:pins.length,e_pin_statuses:counts(pins,"status")},
      security:{credentials_not_mapped:true,personal_identifiers_not_returned:true,e_pin_codes_not_returned:true},
      note:"Read-only audit only. No business data was changed."
    });
  } catch(e) {
    return res.status(500).json({ok:false,error:"source_preview_failed",message:String(e?.message||e).slice(0,180)});
  }
}