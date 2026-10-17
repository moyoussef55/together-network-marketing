import { db, storage } from "hatchable";
import crypto from "node:crypto";
export const access = "public";
export const methods = ["GET"];

export default async function(req,res) {
  const token = String(req.query?.token || "").trim();
  if (!/^[a-f0-9]{64}$/i.test(token)) return res.status(404).send("الرابط غير صالح أو تم إلغاؤه.");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const row = await db.query("SELECT storage_key FROM agent_document_access_tokens WHERE token_hash=$1 AND revoked_at IS NULL LIMIT 1",[hash]);
  if (!row.rows.length) return res.status(404).send("الرابط غير صالح أو تم إلغاؤه.");
  const url = await storage.url(row.rows[0].storage_key,{ttl:300});
  res.setHeader("Cache-Control","no-store, private");
  return res.redirect(302,url);
}