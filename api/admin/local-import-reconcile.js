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
const phoneKey = v => {
  let d = String(v ?? "").replace(/\D/g, "");
  if (d.startsWith("0020")) d = d.slice(4);
  else if (d.startsWith("20") && d.length >= 12) d = d.slice(2);
  if (d.startsWith("0") && d.length === 11) d = d.slice(1);
  return d.length >= 10 ? d.slice(-10) : d;
};
const namePart = v => String(v ?? "").trim().toLowerCase().replace(/[\s\u0640]+/g, " ");
const nameMatch = (a,p) => {
  const af = namePart(a?.firstName), al = namePart(a?.lastName);
  const pf = namePart(p?.first_name), pl = namePart(p?.fourth_name || p?.third_name);
  return !!af && !!al && !!pf && !!pl && af === pf && al === pl;
};
const add = (m,k,id) => {
  k=norm(k); if(!k)return;
  if(!m.has(k))m.set(k,new Set());
  m.get(k).add(String(id));
};
const sum = (rows,key) => (rows||[]).reduce((a,x)=>a+num(x?.[key]),0);
const statuses = (rows,key,amountKey) => {
  const out={};
  for(const row of rows||[]){
    const k=String(row?.[key]??"(empty)").toLowerCase();
    const v=amountKey?num(row?.[amountKey]):0;
    if(!out[k])out[k]={records:0,total:0};
    out[k].records++;out[k].total+=v;
  }
  return out;
};
const nz = (v) => num(v)!==0;

export default async function(req,res) {
  if(!(await requireAdminSession(req,res))) return;
  try {
    const uq=await db.query("SELECT id,filename,expected_bytes,expected_chunks,status,staged_at FROM local_migration_uploads WHERE id=$1 LIMIT 1",[UPLOAD_ID]);
    if(!uq.rows.length)return res.status(404).json({ok:false,error:"staged_upload_not_found"});
    if(uq.rows[0].status!=="staged")return res.status(409).json({ok:false,error:"upload_not_staged"});
    const cq=await db.query("SELECT chunk_index,content FROM local_migration_upload_chunks WHERE upload_id=$1 ORDER BY chunk_index",[UPLOAD_ID]);
    if(cq.rows.length!==Number(uq.rows[0].expected_chunks))return res.status(409).json({ok:false,error:"chunk_count_mismatch"});
    const raw=cq.rows.map(x=>x.content).join("");
    if(raw.length!==Number(uq.rows[0].expected_bytes))return res.status(409).json({ok:false,error:"payload_length_mismatch"});
    const source=JSON.parse(raw);
    if(source.exportFormat!=="together-network-migration-v1")return res.status(400).json({ok:false,error:"unexpected_export_format"});

    const coll=source.collections||{};
    const agents=Array.isArray(coll.agents)?coll.agents:[];
    const bh=Array.isArray(coll.balancehistories)?coll.balancehistories:[];
    const ah=Array.isArray(coll.agenthistories)?coll.agenthistories:[];
    const withdrawals=Array.isArray(coll.withdraws)?coll.withdraws:[];
    const transfers=Array.isArray(coll.transferhistories)?coll.transferhistories:[];
    const profilesQ=await db.query("SELECT id,email,phone,legacy_member_code,referral_code,first_name,second_name,third_name,fourth_name FROM app_profiles WHERE role='marketer'");
    const profiles=profilesQ.rows;

    const byId=new Map(),byCode=new Map(),byEmail=new Map(),byPhone=new Map();
    for(const p of profiles){
      add(byId,p.id,p.id);
      add(byCode,p.legacy_member_code,p.id);
      add(byCode,p.referral_code,p.id);
      add(byEmail,p.email,p.id);
      add(byPhone,phoneKey(p.phone),p.id);
    }
    const sourcePhoneCounts=new Map();
    for(const a of agents){const k=phoneKey(a.phone);if(k)sourcePhoneCounts.set(k,(sourcePhoneCounts.get(k)||0)+1);}

    const mapping=new Map();
    let exact=0,code=0,email=0,phoneName=0,phoneCandidates=0,unmatched=0,ambiguous=0;
    for(const a of agents){
      const sourceId=idOf(a._id);
      const sets=[byId.get(norm(sourceId)),byCode.get(a.id),byEmail.get(a.email)].filter(Boolean);
      const ids=new Set(sets.flatMap(s=>[...s]));
      if(ids.size===0){
        const pk=phoneKey(a.phone), candidates=byPhone.get(pk);
        if(pk && candidates && candidates.size===1 && sourcePhoneCounts.get(pk)===1){
          phoneCandidates++;
          const targetId=[...candidates][0], profile=profiles.find(p=>String(p.id)===targetId);
          if(nameMatch(a,profile)){ids.add(targetId);phoneName++;}
        }
      }
      if(ids.size>1){ambiguous++;continue;}
      if(ids.size===0){unmatched++;continue;}
      const targetId=[...ids][0];
      mapping.set(sourceId,targetId);
      if(byId.has(norm(sourceId)))exact++;
      else if(byCode.has(norm(a.id)))code++;
      else if(byEmail.has(norm(a.email)))email++;
    }
    const targetUse={};
    for(const [src,tgt] of mapping)targetUse[tgt]=(targetUse[tgt]||0)+1;
    const multiTargets=Object.values(targetUse).filter(n=>n>1).length;
    const mappedIds=[...new Set(mapping.values())];

    const walletQ=mappedIds.length?await db.query(
      "SELECT p.id,get_admin_marketer_wallet_balance(p.id::text)::numeric AS current_balance FROM app_profiles p WHERE p.id::text=ANY($1::text[])",
      [mappedIds]
    ):{rows:[]};
    const walletById=new Map(walletQ.rows.map(x=>[String(x.id),num(x.current_balance)]));
    let walletCompare={matched_accounts:mapping.size,source_total:0,target_current_total:0,exact_matches:0,mismatches:0,source_nonzero_target_zero:0,source_zero_target_nonzero:0,max_absolute_difference:0};
    for(const a of agents){
      const t=mapping.get(idOf(a._id)); if(!t)continue;
      const s=num(a.balance),v=walletById.get(t)||0,d=Math.abs(s-v);
      walletCompare.source_total+=s;walletCompare.target_current_total+=v;
      if(d<0.005)walletCompare.exact_matches++;
      else walletCompare.mismatches++;
      if(s!==0&&v===0)walletCompare.source_nonzero_target_zero++;
      if(s===0&&v!==0)walletCompare.source_zero_target_nonzero++;
      walletCompare.max_absolute_difference=Math.max(walletCompare.max_absolute_difference,d);
    }

    const bvQ=mappedIds.length?await db.query(
      "SELECT member_id,account_position,total_right,total_left,carry_right,carry_left FROM network_bv_balances WHERE member_id::text=ANY($1::text[])",
      [mappedIds]
    ):{rows:[]};
    const bvByKey=new Map(bvQ.rows.map(x=>[String(x.member_id)+"|"+Number(x.account_position),x]));
    const srcFields={
      1:["rightPv","leftPv","carryRight","carryLeft"],
      2:["rightPv2","leftPv2","carryRight2","carryLeft2"],
      3:["rightPv3","leftPv3","carryRight3","carryLeft3"]
    };
    const targetFields=["total_right","total_left","carry_right","carry_left"];
    const bvCompare={accounts_expected:mapping.size*3,rows_present:bvQ.rows.length,rows_missing:0,accounts_exact:0,accounts_mismatched:0,source_sums:{},target_sums:{}};
    for(const k of ["total_right","total_left","carry_right","carry_left"]){bvCompare.source_sums[k]=0;bvCompare.target_sums[k]=0;}
    for(const a of agents){
      const t=mapping.get(idOf(a._id));if(!t)continue;
      for(const pos of [1,2,3]){
        const row=bvByKey.get(t+"|"+pos);
        if(!row)bvCompare.rows_missing++;
        let exactRow=true;
        const sf=srcFields[pos];
        for(let i=0;i<4;i++){
          const sv=num(a[sf[i]]),tv=row?num(row[targetFields[i]]):0;
          bvCompare.source_sums[targetFields[i]]+=sv;
          bvCompare.target_sums[targetFields[i]]+=tv;
          if(sv!==tv)exactRow=false;
        }
        if(exactRow)bvCompare.accounts_exact++;else bvCompare.accounts_mismatched++;
      }
    }

    const settlementsQ=mappedIds.length?await db.query(
      "SELECT count(*)::int AS records,COALESCE(sum(check_amount),0)::numeric AS total_checks FROM network_bv_settlements WHERE member_id::text=ANY($1::text[])",
      [mappedIds]
    ):{rows:[{records:0,total_checks:0}]};
    const salesChecksQ=mappedIds.length?await db.query(
      "SELECT count(*)::int AS records,COALESCE(sum(check_amount),0)::numeric AS total_checks FROM network_balance_checks WHERE marketer_id::text=ANY($1::text[])",
      [mappedIds]
    ):{rows:[{records:0,total_checks:0}]};
    const placementQ=mappedIds.length?await db.query(
      "SELECT count(*)::int AS records,count(DISTINCT member_id)::int AS distinct_members FROM network_placements WHERE owner_marketer_id::text=ANY($1::text[]) OR member_id::text=ANY($1::text[])",
      [mappedIds]
    ):{rows:[{records:0,distinct_members:0}]};
    const walletTxQ=mappedIds.length?await db.query(
      "SELECT count(*)::int AS records,COALESCE(sum(amount),0)::numeric AS signed_total FROM wallet_transactions WHERE user_id::text=ANY($1::text[])",
      [mappedIds]
    ):{rows:[{records:0,signed_total:0}]};

    const sourceIdSet=new Set(agents.map(a=>idOf(a._id)).filter(Boolean));
    let parentRefs=0,parentResolved=0,childRefs=0,childResolved=0;
    const childRefsList=[];
    for(const a of agents){
      const parent=idOf(a.parent);if(parent){parentRefs++;if(sourceIdSet.has(parent))parentResolved++;}
      for(const key of ["leftChild0","rightChild0","leftChild1","rightChild1"]){
        const child=idOf(a[key]);if(child&&child!=="000000000000000000000000"){
          childRefs++;childRefsList.push(child);if(sourceIdSet.has(child))childResolved++;
        }
      }
    }
    const duplicateChildAssignments=childRefsList.length-new Set(childRefsList).size;

    const historyIds=new Set(ah.map(x=>idOf(x.agentId)).filter(Boolean));
    const amountByStatus=statuses(bh,"status","value");
    const sourceCommission={
      commission: {sum:sum(agents,"commission"),nonzero:agents.filter(x=>nz(x.commission)).length},
      commission2: {sum:sum(agents,"commission2"),nonzero:agents.filter(x=>nz(x.commission2)).length},
      commission3: {sum:sum(agents,"commission3"),nonzero:agents.filter(x=>nz(x.commission3)).length},
      totalCommission: {sum:sum(agents,"totalCommission"),nonzero:agents.filter(x=>nz(x.totalCommission)).length},
      holdingCommission: {sum:sum(agents,"holdingCommission"),nonzero:agents.filter(x=>nz(x.holdingCommission)).length},
      holdingCommission2: {sum:sum(agents,"holdingCommission2"),nonzero:agents.filter(x=>nz(x.holdingCommission2)).length},
      holdingCommission3: {sum:sum(agents,"holdingCommission3"),nonzero:agents.filter(x=>nz(x.holdingCommission3)).length},
      commissionStatus: statuses(agents,"commissionStatus",null)
    };
    return res.json({
      ok:true,mode:"read_only_reconciliation",
      upload:{id:UPLOAD_ID,status:uq.rows[0].status,characters:raw.length,chunks:cq.rows.length},
      matching:{source_agents:agents.length,target_marketers:profiles.length,unique_matches:mapping.size,exact_source_id:exact,member_code:code,email:email,phone_plus_first_last_name:phoneName,unique_phone_candidates_reviewed:phoneCandidates,unmatched,ambiguous,multiple_source_agents_for_same_target:multiTargets},
      wallet_comparison:walletCompare,
      bv_comparison:bvCompare,
      existing_target_data:{wallet_transaction_rows:walletTxQ.rows[0],weekly_bv_settlements:settlementsQ.rows[0],legacy_balance_checks:salesChecksQ.rows[0],related_placement_rows:placementQ.rows[0]},
      source_history:{agent_history_rows:ah.length,agents_with_agent_history:historyIds.size,balance_history_rows:bh.length,balance_history_by_status:amountByStatus,withdrawals:{records:withdrawals.length,total:sum(withdrawals,"request"),by_status:statuses(withdrawals,"status","request")},transfers:{records:transfers.length,total:sum(transfers,"request")}},
      source_commission_fields:sourceCommission,
      source_network_references:{parent_references:parentRefs,parent_resolved_to_source_member:parentResolved,child_references:childRefs,child_resolved_to_source_member:childResolved,duplicate_child_assignments:duplicateChildAssignments},
      policy:{no_profiles_wallets_bv_placements_or_checks_changed:true,e_pin_records_not_imported:true,credentials_not_imported:true},
      warning:"This is a read-only comparison. A subsequent hourly BV refresh rebuilds totals from network_bv_ledger, so importing only network_bv_balances would not persist historical totals."
    });
  } catch(e) {
    return res.status(500).json({ok:false,error:"reconciliation_failed",message:String(e?.message||e).slice(0,200)});
  }
}