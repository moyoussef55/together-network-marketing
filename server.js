import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import multer from "multer";
import cookieParser from "cookie-parser";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { closeRuntimeResources, verifyStorageSignature } from "hatchable";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const API_DIR = path.join(__dirname, "api");
const PORT = Number(process.env.PORT || 3000);
const HATCHABLE_API_ORIGIN = "https://together-network.hatchable.site";
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS || 1));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});


const STORAGE_ROOT = path.resolve(process.env.STORAGE_DIR || "./var/uploads");
const EVENT_UPLOAD_TEMP_DIR = path.join(STORAGE_ROOT, ".incoming-events");
const eventDiskUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdir(EVENT_UPLOAD_TEMP_DIR, { recursive: true }).then(
        () => cb(null, EVENT_UPLOAD_TEMP_DIR),
        error => cb(error)
      );
    },
    filename: (_req, _file, cb) => cb(null, crypto.randomUUID() + ".upload")
  }),
  // Stream uploads to disk. Do not set a fileSize limit here: the previous
  // proxy path was capped at 50 MB and also buffered the complete video.
  limits: { files: 12, fields: 200, fieldSize: 25 * 1024 * 1024 }
});

// Authenticate before accepting the request body, then stream the video to disk
// and call the local event handler (which shares the production database).
app.post("/api/admin/events", async (req, res) => {
  try {
    const authModule = await import(pathToFileURL(path.join(__dirname, "lib/admin-auth.js")).href);
    if (!(await authModule.requireAdminSession(req, res))) return;
  } catch (error) {
    console.error("Event upload auth check failed:", error?.code || error?.name || "Error");
    if (!res.headersSent) return res.status(500).json({ ok: false, error: "admin_auth_unavailable" });
    return;
  }

  eventDiskUpload.any()(req, res, async error => {
    const cleanup = () => Promise.all((req.files || []).map(file =>
      file.path ? fs.rm(file.path, { force: true }).catch(() => {}) : Promise.resolve()
    ));
    if (error) {
      await cleanup();
      if (error instanceof multer.MulterError) {
        const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
        return res.status(status).json({ ok: false, error: "upload_rejected", code: error.code });
      }
      console.error("Event upload stream failed:", error?.code || error?.name || "Error");
      return res.status(400).json({ ok: false, error: "upload_stream_failed" });
    }

    req.files = (req.files || []).map(file => ({
      field: file.fieldname,
      filename: file.originalname,
      contentType: file.mimetype,
      path: file.path,
      size: file.size
    }));

    try {
      const handlerPath = path.join(API_DIR, "admin", "events.js");
      const handler = await import(pathToFileURL(handlerPath).href);
      if (typeof handler.default !== "function") throw new Error("invalid_event_handler");
      await handler.default(req, res);
    } catch (handlerError) {
      await cleanup();
      console.error("Streamed event upload handler failed:", handlerError?.code || handlerError?.name || "Error");
      if (!res.headersSent) return res.status(500).json({ ok: false, error: "event_save_failed" });
    }
  });
});

app.use("/api", async (req, res, next) => {
  // These SEO endpoints run on Namecheap but use the same Hatchable PostgreSQL database.
  // All other API routes continue through the existing Hatchable proxy unchanged.
  if (["/admin/seo-settings", "/admin/seo-generate", "/seo-public"].includes(req.path)) return next();
  let target;
  try {
    target = new URL(req.originalUrl, HATCHABLE_API_ORIGIN);
    if (target.origin !== HATCHABLE_API_ORIGIN || !target.pathname.startsWith("/api/")) {
      return res.status(400).json({ error: "invalid_api_path" });
    }
  } catch {
    return res.status(400).json({ error: "invalid_api_path" });
  }

  try {
    const headers = new Headers();
    const allowedRequestHeaders = [
      "accept", "accept-language", "authorization", "cookie", "content-type",
      "if-match", "if-none-match", "if-modified-since", "if-unmodified-since",
      "range", "user-agent", "x-csrf-token", "x-xsrf-token", "x-requested-with"
    ];
    for (const name of allowedRequestHeaders) {
      const value = req.headers[name];
      if (typeof value === "string" && value) headers.set(name, value);
    }
    headers.set("origin", HATCHABLE_API_ORIGIN);
    headers.set("referer", target.href);

    const init = {
      method: req.method,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(Math.max(1000, Math.min(60000, Number(process.env.HATCHABLE_API_TIMEOUT_MS || 30000))))
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      init.body = req;
      init.duplex = "half";
    }

    const upstream = await fetch(target, init);
    res.status(upstream.status);
    for (const name of [
      "content-type", "cache-control", "etag", "last-modified", "content-disposition",
      "vary", "allow", "retry-after", "www-authenticate", "content-language",
      "accept-ranges", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"
    ]) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }

    const cookies = typeof upstream.headers.getSetCookie === "function"
      ? upstream.headers.getSetCookie()
      : [];
    if (cookies.length) res.setHeader("Set-Cookie", cookies);
    else {
      const cookie = upstream.headers.get("set-cookie");
      if (cookie) res.setHeader("Set-Cookie", cookie);
    }

    const location = upstream.headers.get("location");
    if (location) {
      try {
        const redirect = new URL(location, HATCHABLE_API_ORIGIN);
        if (redirect.origin === HATCHABLE_API_ORIGIN) {
          const publicBase = (req.protocol || "https") + "://" + req.get("host");
          res.setHeader("Location", publicBase + redirect.pathname + redirect.search + redirect.hash);
        } else {
          res.setHeader("Location", location);
        }
      } catch {
        res.setHeader("Location", location);
      }
    }

    if (req.method === "HEAD" || !upstream.body) return res.end();
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (error) {
    console.error("Hatchable API proxy failed:", req.method, req.originalUrl, error?.cause?.code || error?.name || "Error");
    if (res.headersSent) return res.destroy();
    return res.status(502).json({ error: "hatchable_api_unavailable" });
  }
});

app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));
app.use(cookieParser());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024, files: 12, fields: 200, fieldSize: 25 * 1024 * 1024 }
});

app.get("/healthz", async (_req, res) => {
  const status = {
    ok: true,
    runtime: "namecheap-node",
    api_mode: "hatchable-proxy",
    upstream: HATCHABLE_API_ORIGIN
  };
  try {
    const upstream = await fetch(HATCHABLE_API_ORIGIN + "/api/homepage-settings", {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5000)
    });
    status.upstream_status = upstream.status;
    status.api_access = upstream.ok ? "available" : "rejected";
    if (!upstream.ok) {
      status.ok = false;
      return res.status(503).json(status);
    }
    return res.json(status);
  } catch {
    status.ok = false;
    status.api_access = "unreachable";
    return res.status(503).json(status);
  }
});
app.get("/event-media", async (req, res) => {
  const key = String(req.query.key || "");
  if (!/^namecheap-events\/[a-f0-9-]{36}\.(?:jpg|png|webp|gif|mp4|webm|mov)$/i.test(key)) return res.status(404).end();
  const target = path.resolve(STORAGE_ROOT, key);
  if (target === STORAGE_ROOT || !target.startsWith(STORAGE_ROOT + path.sep)) return res.status(404).end();
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile()) return res.status(404).end();
    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("Accept-Ranges", "bytes");
    return res.sendFile(target);
  } catch {
    return res.status(404).end();
  }
});

app.get("/uploads", async (req, res) => {
  const key = String(req.query.key || "");
  const expires = String(req.query.expires || "");
  const sig = String(req.query.sig || "");
  if (!verifyStorageSignature(key, expires, sig)) return res.status(404).end();
  try {
    const root = path.resolve(process.env.STORAGE_DIR || "./var/uploads");
    const safe = key.replace(/\\/g, "/");
    if (!safe || safe.startsWith("/") || safe.includes("\0") || safe.split("/").some(p => !p || p === "." || p === "..")) return res.status(404).end();
    const target = path.resolve(root, safe);
    if (target !== root && !target.startsWith(root + path.sep)) return res.status(404).end();
    await fs.access(target);
    res.setHeader("Cache-Control", "private, max-age=300");
    return res.sendFile(target);
  } catch { return res.status(404).end(); }
});

app.use("/api", upload.any(), async (req, res) => {
  const pathname = new URL(req.originalUrl, "http://localhost").pathname;
  let relative;
  try {
    relative = decodeURIComponent(pathname.startsWith("/api/") ? pathname.slice(5) : "");
    if (relative.endsWith("/")) relative = relative.slice(0, -1);
  }
  catch { return res.status(400).json({ error: "invalid_path" }); }
  if (!relative || relative.includes("\0")) return res.status(404).json({ error: "not_found" });
  const target = path.resolve(API_DIR, `${relative}.js`);
  if (target !== API_DIR && !target.startsWith(API_DIR + path.sep)) return res.status(404).json({ error: "not_found" });
  try { await fs.access(target); } catch { return res.status(404).json({ error: "not_found" }); }

  if (relative === "jobs/network-bv-weekly") {
    const secret = String(process.env.CRON_SECRET || "");
    const authorization = String(req.headers.authorization || "");
    const supplied = authorization.slice(0, 7).toLowerCase() === "bearer " ? authorization.slice(7).trim() : "";
    const a = Buffer.from(secret);
    const b = Buffer.from(supplied);
    if (secret.length < 32 || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(404).json({ error: "not_found" });
    req.headers["x-hatchable-trigger"] = "cron";
  }

  req.files = (req.files || []).map(file => ({
    field: file.fieldname, filename: file.originalname, contentType: file.mimetype, buffer: file.buffer, size: file.size
  }));

  // Reject unsupported HTTP methods before importing a handler. Some handlers
  // import the Hatchable SDK at module load time, so method validation must not
  // depend on a database/runtime package just to return a correct 405 response.
  try {
    const handlerSource = await fs.readFile(target, "utf8");
    const methodDeclaration = handlerSource.match(/export\s+const\s+methods\s*=\s*\[([^\]]*)\]\s*;/);
    if (methodDeclaration) {
      const allowedMethods = [...methodDeclaration[1].matchAll(/["']([A-Z]+)["']/g)].map(match => match[1]);
      if (allowedMethods.length && !allowedMethods.includes(req.method)) {
        res.setHeader("Allow", allowedMethods.join(", "));
        return res.status(405).json({ error: "method_not_allowed" });
      }
    }
  } catch (error) {
    console.error("API method precheck failed:", relative, error?.code || error?.name || "Error");
    return res.status(500).json({ error: "internal_error" });
  }

  try {
    const mod = await import(pathToFileURL(target).href);
    if (typeof mod.default !== "function") return res.status(500).json({ error: "invalid_api_handler" });
    if (Array.isArray(mod.methods) && !mod.methods.includes(req.method)) {
      res.setHeader("Allow", mod.methods.join(", "));
      return res.status(405).json({ error: "method_not_allowed" });
    }
    return await mod.default(req, res);
  } catch (error) {
    console.error("API handler failed:", relative, error?.code || error?.name || "Error");
    if (res.headersSent) return;
    return res.status(500).json({ error: "internal_error" });
  }
});

app.use(async (req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  const pathname = new URL(req.originalUrl, "http://localhost").pathname;
  if (pathname === "/" || pathname.startsWith("/api/") || pathname === "/uploads") return next();
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return next(); }
  const base = path.resolve(PUBLIC_DIR, `.${decoded}`);
  if (base !== PUBLIC_DIR && !base.startsWith(PUBLIC_DIR + path.sep)) return next();
  for (const candidate of [`${base}.html`, path.join(base, "index.html")]) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return res.sendFile(candidate);
    } catch {}
  }
  return next();
});

app.use(express.static(PUBLIC_DIR, { index: "index.html", dotfiles: "deny", fallthrough: true }));
app.use((_req, res) => res.status(404).send("Not found"));
app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) return res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: "upload_rejected", code: error.code });
  console.error("Request middleware failed:", error?.code || error?.name || "Error");
  if (!res.headersSent) return res.status(500).json({ error: "internal_error" });
});

const server = app.listen(PORT, "0.0.0.0", () => console.log(`Together Network runtime listening on port ${PORT}`));
// Large event videos may take longer than Node’s default 5-minute request deadline.
server.requestTimeout = 0;
server.timeout = 0;
async function shutdown() {
  server.close(async () => { await closeRuntimeResources().catch(() => {}); process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
