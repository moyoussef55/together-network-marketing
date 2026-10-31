import crypto from "node:crypto";
import { db } from "hatchable";

const WINDOW_MINUTES = 15;
const hashKey = value => crypto.createHash("sha256").update(String(value)).digest("hex");

function clientAddress(req) {
  const value = String(req?.ip || req?.headers?.["cf-connecting-ip"] || req?.headers?.["x-real-ip"] || req?.socket?.remoteAddress || "").trim();
  return value.slice(0, 128);
}

export async function enforceLoginRateLimit(req, identifier, kind = "login") {
  const normalized = String(identifier || "").trim().toLowerCase().slice(0, 254);
  const ip = clientAddress(req);
  const buckets = [{ key: kind + ":identifier:" + normalized, limit: 20 }];
  if (ip) {
    buckets.push({ key: kind + ":ip:" + ip, limit: 60 });
    buckets.push({ key: kind + ":pair:" + ip + ":" + normalized, limit: 10 });
  }
  const checks = await Promise.all(buckets.map(async bucket => {
    const key = hashKey(bucket.key);
    const result = await db.query(
      `INSERT INTO network_login_rate_limits(bucket_key,attempts,window_started_at,updated_at)
       VALUES($1,1,now(),now())
       ON CONFLICT(bucket_key) DO UPDATE SET
         attempts=CASE
           WHEN network_login_rate_limits.window_started_at <= now()-interval '${WINDOW_MINUTES} minutes' THEN 1
           ELSE network_login_rate_limits.attempts+1
         END,
         window_started_at=CASE
           WHEN network_login_rate_limits.window_started_at <= now()-interval '${WINDOW_MINUTES} minutes' THEN now()
           ELSE network_login_rate_limits.window_started_at
         END,
         updated_at=now()
       RETURNING attempts,window_started_at`,
      [key]
    );
    return { ...bucket, attempts: Number(result.rows[0]?.attempts || 0), windowStartedAt: result.rows[0]?.window_started_at };
  }));
  await db.query("DELETE FROM network_login_rate_limits WHERE updated_at < now()-interval '2 days'").catch(() => {});
  const blocked = checks.filter(item => item.attempts > item.limit);
  if (!blocked.length) return { blocked: false, retryAfterSeconds: 0 };
  const retryAfterSeconds = Math.max(1, ...blocked.map(item => {
    const start = new Date(item.windowStartedAt).getTime();
    return Number.isFinite(start) ? Math.ceil((start + WINDOW_MINUTES*60*1000 - Date.now())/1000) : 60;
  }));
  return { blocked: true, retryAfterSeconds };
}