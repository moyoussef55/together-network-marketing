import { db } from "hatchable";
import { requireAdminSession } from "../../lib/admin-auth.js";
export const access = "public";
export const methods = ["GET"];
const UPLOAD_ID="773fcb03-0b45-403d-b060-1d040175b4cc";
const objId=v=>v&&typeof v==="object"?String(v.$oid||v._id||""):String(v||"");
const s=v=>String(v??"").trim();
const key=v=>s(v).toLowerCase();
const date=v=>{const x=v&&typeof v==="object"&&v.$date?v.$date:v;const d=x?new Date(x):null;return d&&!Number.isNaN(d.valueOf())?d:null};
const num=v=>{if(v==null||v==="")return 0;if(typeof v==="object")return Number(v.$numberLong??v.$numberInt??v.$numberDouble??v.$numberDecimal??0)||0;return Number(v)||0};
const dateString=value=>{if(value==null||value==="")return null;const d=value instanceof Date?value:new Date(value);return Number.isNaN(d.valueOf())?String(value):d.toISOString();};
const BV=["rightPv","leftPv","carryRight","carryLeft","rightPv2","leftPv2","carryRight2","carryLeft2","rightPv3","leftPv3","carryRight3","carryLeft3"];
const GROUPS=["role","block","isVerified","packageActivate","commissionStatus"];
function groups(rows,f){const o={};for(const r of rows){const v=String(r?.[f]??"(empty)").toLowerCase();o[v]=(o[v]||0)+1;}return o;}
export default async function(req,res){
 if(!(await requireAdminSession(req,res)))return;
 let stage="begin";
 try{
  stage="staged_upload";
  const u=await db.query("SELECT expected_bytes,expected_chunks,status FROM local_migration_uploads WHERE id=$1",[UPLOAD_ID]);
  if(!u.rows.length||u.rows[0].status!=="staged")return res.status(404).json({ok:false,error:"staged_source_unavailable"});
  stage="staged_chunks";
  const c=await db.query("SELECT content FROM local_migration_upload_chunks WHERE upload_id=$1 ORDER BY chunk_index",[UPLOAD_ID]);
  const raw=c.rows.map(x=>x.content).join("");
  if(c.rows.length!==Number(u.rows[0].expected_chunks)||raw.length!==Number(u.rows[0].expected_bytes))return res.status(409).json({ok:false,error:"staged_source_integrity_error"});
  stage="source_parse";
  const source=JSON.parse(raw),col=source.collections||{},agents=col.agents||[],hist=col.agenthistories||[];
  stage="load_profiles";
  const pQ=await db.query("SELECT id,email,phone,legacy_member_code,referral_code FROM app_profiles WHERE role='marketer'");
  const profiles=pQ.rows,byId=new Map(),byCode=new Map(),byEmail=new Map();
  const add=(m,k,v)=>{k=key(k);if(!k)return;if(!m.has(k))m.set(k,new Set());m.get(k).add(String(v));};
  for(const p of profiles){add(byId,p.id,p.id);add(byCode,p.legacy_member_code,p.id);add(byCode,p.referral_code,p.id);add(byEmail,p.email,p.id);}
  const mapping=new Map(),unmatched=[];
  for(const a of agents){const sid=objId(a._id);const sets=[byId.get(key(sid)),byCode.get(a.id),byEmail.get(a.email)].filter(Boolean);const ids=new Set(sets.flatMap(x=>[...x]));if(ids.size===1)mapping.set(sid,[...ids][0]);else if(ids.size===0)unmatched.push(a);}
  const mappedIds=[...mapping.values()];
  stage="load_placements";
  const placementQ=await db.query("SELECT owner_marketer_id,account_position,side,member_id,parent_member_id FROM network_placements WHERE owner_marketer_id::text=ANY($1::text[]) OR member_id::text=ANY($1::text[])",[mappedIds]);
  const actualByChild=new Map(),actualSlots=new Map();
  for(const p of placementQ.rows){actualByChild.set(String(p.member_id),p);actualSlots.set([String(p.owner_marketer_id),Number(p.account_position),p.side].join("|"),p);}
  const expected=[];
  for(const parent of agents){
    const parentSource=objId(parent._id),owner=mapping.get(parentSource);
    for(const [field,pos,side] of [["leftChild0",2,"left"],["rightChild0",2,"right"],["leftChild1",3,"left"],["rightChild1",3,"right"]]){
      const childSource=objId(parent[field]);if(!childSource||childSource==="000000000000000000000000")continue;
      expected.push({parentSource,childSource,owner:mapping.get(parentSource),child:mapping.get(childSource),position:pos,side});
    }
  }
  let exact=0,missing=0,mismatched=0,slotOccupied=0,unmappedEdges=0;
  const mismatchedRows=[];
  for(const e of expected){
    if(!e.owner||!e.child){unmappedEdges++;continue;}
    const row=actualByChild.get(e.child);
    if(row){
      if(String(row.owner_marketer_id)===e.owner&&Number(row.account_position)===e.position&&row.side===e.side)exact++;
      else {mismatched++;mismatchedRows.push({expected_position:e.position,expected_side:e.side,actual_position:Number(row.account_position),actual_side:row.side});}
    }else{
      const occupied=actualSlots.get([e.owner,e.position,e.side].join("|"));
      if(occupied)slotOccupied++;
      else missing++;
    }
  }
  const expectedChildSet=new Set(expected.filter(e=>e.child).map(e=>e.child));
  const extras=placementQ.rows.filter(p=>mapping.has(String(p.member_id))&&!expectedChildSet.has(String(p.member_id))).length;
  const historyByAgent=new Map();
  for(const h of hist){const id=objId(h.agentId);if(!id)continue;if(!historyByAgent.has(id))historyByAgent.set(id,[]);historyByAgent.get(id).push(h);}
  const currentById=new Map(agents.map(a=>[objId(a._id),a]));
  let agentsWithHistory=0,latestCurrentMatches=0,latestCurrentDiff=0,historyRowsCompared=0;
  let minDate=null,maxDate=null,historyWithDate=0,negativeSnapshotDeltas=0;
  let posSnapshotDeltas=0;
  const latestDatePerSource={};
  for(const [id,rows] of historyByAgent){
    const ordered=rows.slice().sort((a,b)=>(date(a.createdAt)?.valueOf()||date(a.updatedAt)?.valueOf()||0)-(date(b.createdAt)?.valueOf()||date(b.updatedAt)?.valueOf()||0));
    const current=currentById.get(id);
    if(!current)continue;
    agentsWithHistory++;
    const latest=ordered[ordered.length-1];
    let same=true;
    for(const f of BV)if(num(latest[f])!==num(current[f]))same=false;
    if(same)latestCurrentMatches++;else latestCurrentDiff++;
    for(let i=0;i<ordered.length;i++){
      const d=date(ordered[i].createdAt)||date(ordered[i].updatedAt);
      if(d){historyWithDate++;if(!minDate||d<minDate)minDate=d;if(!maxDate||d>maxDate)maxDate=d;}
      if(i>0){
        for(const f of BV){
          const delta=num(ordered[i][f])-num(ordered[i-1][f]);
          if(delta<0)negativeSnapshotDeltas++;
          if(delta>0)posSnapshotDeltas++;
          historyRowsCompared++;
        }
      }
    }
  }
  const candidates=unmatched.map(a=>{
    const created=date(a.createdAt);
    return {
      member_code:s(a.id)||null,
      has_name:!!(s(a.firstName)||s(a.lastName)),
      has_email:!!s(a.email),
      has_phone:!!s(a.phone),
      has_parent:!!objId(a.parent),
      has_referral_code_collision:false,
      source_blocked:!!a.block,
      source_verified:!!a.isVerified,
      package_activated:!!a.packageActivate,
      source_created_at:dateString(created),
      bv_nonzero:BV.some(f=>num(a[f])!==0),
      balance_nonzero:num(a.balance)!==0
    };
  });
  const possibleCodes=unmatched.map(a=>s(a.id)).filter(Boolean);
  stage="check_profile_code_collisions";
  const codeConflicts=possibleCodes.length?await db.query("SELECT count(*)::int n FROM app_profiles WHERE referral_code=ANY($1::text[]) OR legacy_member_code=ANY($1::text[])",[possibleCodes]):{rows:[{n:0}]};
  for(const x of candidates)x.has_referral_code_collision=Number(codeConflicts.rows[0].n)>0;
  stage="load_target_bv_balances";
  const balances=await db.query("SELECT count(*)::int n,COALESCE(sum(total_right),0)::bigint tr,COALESCE(sum(total_left),0)::bigint tl,COALESCE(sum(carry_right),0)::bigint cr,COALESCE(sum(carry_left),0)::bigint cl FROM network_bv_balances WHERE member_id::text=ANY($1::text[])",[mappedIds]);
  stage="load_target_bv_ledger";
  const ledger=await db.query("SELECT count(*)::int n,COALESCE(sum(bv) FILTER(WHERE side='right'),0)::bigint tr,COALESCE(sum(bv) FILTER(WHERE side='left'),0)::bigint tl,min(sale_at) first_sale,max(sale_at) last_sale FROM network_bv_ledger WHERE upline_member_id::text=ANY($1::text[])",[mappedIds]);
  const sourceExportDate=source.createdAt||source.sourceManifest?.createdAt||source.sourceManifest?.created_at||null;
  return res.json({
    ok:true,mode:"read_only_graph_and_history_audit",
    source:{export_created_at:sourceExportDate,agent_status_distributions:Object.fromEntries(GROUPS.map(f=>[f,groups(agents,f)]))},
    new_profile_candidates:{count:candidates.length,member_codes:candidates.map(x=>x.member_code),readiness:{with_name:candidates.filter(x=>x.has_name).length,with_email:candidates.filter(x=>x.has_email).length,with_phone:candidates.filter(x=>x.has_phone).length,with_parent:candidates.filter(x=>x.has_parent).length,blocked:candidates.filter(x=>x.source_blocked).length,unverified:candidates.filter(x=>!x.source_verified).length,package_activated:candidates.filter(x=>x.package_activated).length,with_nonzero_bv:candidates.filter(x=>x.bv_nonzero).length,with_nonzero_balance:candidates.filter(x=>x.balance_nonzero).length},referral_code_collisions:Number(codeConflicts.rows[0].n)},
    network_graph:{source_edges:expected.length,edges_fully_mapped:expected.length-unmappedEdges,exact_matches:exact,missing_edges_with_free_slot:missing,existing_slot_conflicts:slotOccupied,existing_member_placement_mismatches:mismatched,unmapped_edges:unmappedEdges,target_related_placement_rows:placementQ.rows.length,target_matched_children_not_in_source_edge_set:extras},
    source_history:{records:hist.length,agents_with_history_and_current_agent:agentsWithHistory,latest_snapshot_matches_current_agent:latestCurrentMatches,latest_snapshot_differs_from_current_agent:latestCurrentDiff,history_date_count:historyWithDate,first_history_at:dateString(minDate),last_history_at:dateString(maxDate),snapshot_fields_compared:historyRowsCompared,negative_field_deltas:negativeSnapshotDeltas,positive_field_deltas:posSnapshotDeltas},
    target_bv:{balance_rows:Number(balances.rows[0].n),sum_total_right:Number(balances.rows[0].tr),sum_total_left:Number(balances.rows[0].tl),sum_carry_right:Number(balances.rows[0].cr),sum_carry_left:Number(balances.rows[0].cl),ledger_rows:Number(ledger.rows[0].n),ledger_right:Number(ledger.rows[0].tr),ledger_left:Number(ledger.rows[0].tl),first_ledger_sale:dateString(ledger.rows[0].first_sale),last_ledger_sale:dateString(ledger.rows[0].last_sale)},
    candidate_details:candidates,
    safety:{read_only:true,no_profile_or_wallet_or_network_or_bv_writes:true,no_pin_values_or_credentials_returned:true}
  });
 }catch(e){return res.status(500).json({ok:false,error:"deep_audit_failed",stage:typeof stage==="string"?stage:"unknown",message:String(e?.message||e).slice(0,300)});}
}