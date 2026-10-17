import { db } from "hatchable";
import crypto from "node:crypto";
export const access = "public";
export const methods = ["POST"];

const bodyOf = req => typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
const clean = v => String(v ?? "").trim();
const digest = v => crypto.createHash("sha256").update(String(v)).digest("hex");

export default async function(req,res) {
  try {
    const b = bodyOf(req);
    const action = clean(b.action);
    const token = clean(req.headers?.["x-transfer-token"] || b.token);
    if (token.length < 32 || token.length > 200) return res.status(401).json({error:"transfer_token_required"});
    const tokenHash = digest(token);
    const auth = await db.query("SELECT token_hash FROM local_migration_access_tokens WHERE token_hash=$1 AND expires_at>now() AND used_at IS NULL LIMIT 1",[tokenHash]);
    if (!auth.rows.length) return res.status(401).json({error:"transfer_token_invalid_or_expired"});

    if (action === "start") {
      const filename = clean(b.filename);
      const bytes = Number(b.bytes);
      const chunks = Number(b.chunks);
      if (filename !== "together-network-source.json") return res.status(400).json({error:"unexpected_filename"});
      if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 8_000_000) return res.status(400).json({error:"invalid_file_size"});
      if (!Number.isSafeInteger(chunks) || chunks < 1 || chunks > 250) return res.status(400).json({error:"invalid_chunk_count"});
      const existing = await db.query("SELECT id FROM local_migration_uploads WHERE uploaded_by=$1 AND status IN ('receiving','staged') LIMIT 1",[tokenHash]);
      if (existing.rows.length) return res.status(409).json({error:"transfer_already_started",upload_id:existing.rows[0].id});
      const q = await db.query("INSERT INTO local_migration_uploads(filename,expected_bytes,expected_chunks,uploaded_by) VALUES($1,$2,$3,$4) RETURNING id",[filename,bytes,chunks,tokenHash]);
      return res.json({ok:true,upload_id:q.rows[0].id,chunk_size_limit:60000});
    }

    const uploadId = clean(b.upload_id);
    if (!/^[0-9a-f-]{36}$/i.test(uploadId)) return res.status(400).json({error:"invalid_upload_id"});
    const u = await db.query("SELECT id,expected_bytes,expected_chunks,status FROM local_migration_uploads WHERE id=$1 AND uploaded_by=$2 LIMIT 1",[uploadId,tokenHash]);
    if (!u.rows.length) return res.status(404).json({error:"upload_not_found"});
    if (u.rows[0].status !== "receiving" && action !== "status") return res.status(409).json({error:"upload_not_receiving"});

    if (action === "chunk") {
      const index = Number(b.index);
      const content = String(b.content ?? "");
      if (!Number.isSafeInteger(index) || index < 0 || index >= Number(u.rows[0].expected_chunks)) return res.status(400).json({error:"invalid_chunk_index"});
      if (!content.length || content.length > 60000) return res.status(400).json({error:"invalid_chunk_size"});
      await db.query("INSERT INTO local_migration_upload_chunks(upload_id,chunk_index,content) VALUES($1,$2,$3) ON CONFLICT(upload_id,chunk_index) DO UPDATE SET content=EXCLUDED.content",[uploadId,index,content]);
      return res.json({ok:true,index});
    }

    if (action === "finish") {
      const check = await db.query("SELECT count(*)::int AS chunks, COALESCE(sum(length(content)),0)::bigint AS bytes, min(chunk_index)::int AS min_index, max(chunk_index)::int AS max_index FROM local_migration_upload_chunks WHERE upload_id=$1",[uploadId]);
      const c = check.rows[0];
      if (Number(c.chunks) !== Number(u.rows[0].expected_chunks) || Number(c.bytes) !== Number(u.rows[0].expected_bytes) || Number(c.min_index) !== 0 || Number(c.max_index) !== Number(u.rows[0].expected_chunks)-1) {
        return res.status(409).json({error:"upload_integrity_check_failed",received_chunks:Number(c.chunks),received_chars:Number(c.bytes)});
      }
      await db.query("UPDATE local_migration_uploads SET status='staged',staged_at=now() WHERE id=$1",[uploadId]);
      await db.query("UPDATE local_migration_access_tokens SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL",[tokenHash]);
      return res.json({ok:true,status:"staged",received_chunks:Number(c.chunks),received_chars:Number(c.bytes),note:"Staged only; live business tables were not changed."});
    }

    if (action === "status") {
      const c = await db.query("SELECT count(*)::int AS received_chunks, COALESCE(sum(length(content)),0)::bigint AS received_chars FROM local_migration_upload_chunks WHERE upload_id=$1",[uploadId]);
      return res.json({ok:true,status:u.rows[0].status,expected_chunks:Number(u.rows[0].expected_chunks),received_chunks:Number(c.rows[0].received_chunks),expected_bytes:Number(u.rows[0].expected_bytes),received_chars:Number(c.rows[0].received_chars)});
    }
    return res.status(400).json({error:"invalid_action"});
  } catch (e) {
    return res.status(500).json({error:"local_import_staging_failed",message:String(e?.message||e).slice(0,240)});
  }
}