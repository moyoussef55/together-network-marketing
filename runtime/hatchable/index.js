import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import nodemailer from "nodemailer";

const schema = String(process.env.DB_SCHEMA || "public").trim();
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error("DB_SCHEMA must be a simple PostgreSQL schema name");

let pool;
function getPool() {
  if (!process.env.DATABASE_URL) throw new Error("database_not_configured: set DATABASE_URL privately on the server");
  if (!pool) {
    const sslEnabled = !["0", "false", "no"].includes(String(process.env.DATABASE_SSL || "true").toLowerCase());
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${schema},public`,
      ssl: sslEnabled ? { rejectUnauthorized: !["0", "false", "no"].includes(String(process.env.DATABASE_SSL_REJECT_UNAUTHORIZED || "true").toLowerCase()) } : false,
      max: Number(process.env.DB_POOL_MAX || 5),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });
    pool.on("error", error => console.error("Postgres idle-client error:", error?.code || "unknown"));
  }
  return pool;
}

export const db = {
  query(text, params) { return getPool().query(text, params); },
  async end() { if (pool) { const p = pool; pool = undefined; await p.end(); } }
};

const storageRoot = path.resolve(process.env.STORAGE_DIR || "./var/uploads");
function safeKey(key) {
  const value = String(key || "").replace(/\\/g, "/");
  if (!value || value.startsWith("/") || value.includes("\0") || value.split("/").some(part => !part || part === "." || part === "..")) throw new Error("invalid_storage_key");
  return value;
}
function storagePath(key) {
  const safe = safeKey(key);
  const target = path.resolve(storageRoot, safe);
  if (target !== storageRoot && !target.startsWith(storageRoot + path.sep)) throw new Error("invalid_storage_key");
  return target;
}
function signingSecret() {
  const value = String(process.env.STORAGE_SIGNING_SECRET || "");
  if (value.length < 32) throw new Error("STORAGE_SIGNING_SECRET must be at least 32 characters");
  return value;
}
function sign(key, expires) {
  return crypto.createHmac("sha256", signingSecret()).update(`${key}\n${expires}`).digest("hex");
}
export function verifyStorageSignature(key, expires, signature) {
  try {
    const safe = safeKey(key);
    const expiry = Number(expires);
    if (!Number.isInteger(expiry) || expiry < Math.floor(Date.now() / 1000) || expiry > Math.floor(Date.now() / 1000) + 86400) return false;
    const expected = Buffer.from(sign(safe, expiry), "hex");
    const supplied = Buffer.from(String(signature || ""), "hex");
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  } catch { return false; }
}

export const storage = {
  async put(key, data, contentType = "application/octet-stream") {
    const target = storagePath(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    await fs.writeFile(target, bytes, { mode: 0o600 });
    return { key: safeKey(key), bytes: bytes.length, contentType: String(contentType || "application/octet-stream") };
  },
  async del(key) {
    await fs.rm(storagePath(key), { force: true });
    return { ok: true };
  },
  async url(key) {
    if (!key) return null;
    const safe = safeKey(key);
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const params = new URLSearchParams({ key: safe, expires: String(expires), sig: sign(safe, expires) });
    const baseValue = String(process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`);
    const base = baseValue.endsWith("/") ? baseValue.slice(0, -1) : baseValue;
    return `${base}/uploads?${params.toString()}`;
  }
};

export const config = {
  async get(name) { return process.env[String(name)] ?? ""; }
};

let mailTransport;
function getMailTransport() {
  if (mailTransport) return mailTransport;
  const host = String(process.env.SMTP_HOST || "").trim();
  const user = String(process.env.SMTP_USER || "").trim();
  const pass = String(process.env.SMTP_PASS || "");
  if (!host || !user || !pass) throw new Error("smtp_not_configured");
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = ["1", "true", "yes"].includes(String(process.env.SMTP_SECURE || "false").toLowerCase());
  mailTransport = nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
  return mailTransport;
}
export const email = {
  async send(message) {
    const from = String(process.env.SMTP_FROM || process.env.SMTP_USER || "").trim();
    if (!from) throw new Error("smtp_from_not_configured");
    return getMailTransport().sendMail({ from, to: message?.to, subject: message?.subject, html: message?.html, text: message?.text });
  }
};

export async function closeRuntimeResources() {
  await db.end();
  if (mailTransport) { mailTransport.close(); mailTransport = undefined; }
};
