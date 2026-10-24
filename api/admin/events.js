import { db, storage } from "hatchable";
import { requireAdminSession } from "../../lib/admin-auth.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const access = "public";
export const methods = ["GET","POST","PUT","DELETE"];

const ROOT = path.resolve(process.env.STORAGE_DIR || "./var/uploads");
const NAMECHEAP_MEDIA_ORIGIN = "https://marketing.together-v-egp.com";
const allowed = new Map([
  ["image/jpeg","jpg"], ["image/png","png"], ["image/webp","webp"], ["image/gif","gif"],
  ["video/mp4","mp4"], ["video/webm","webm"], ["video/quicktime","mov"]
]);

async function mediaUrl(key) {
  const value = String(key || "");
  if (value.startsWith("namecheap-events/")) {
    return NAMECHEAP_MEDIA_ORIGIN + "/event-media?key=" + encodeURIComponent(value);
  }
  return storage.url(value);
}

async function discardTempFiles(files) {
  await Promise.all((files || []).map(async file => {
    if (file?.path) await fs.rm(file.path, { force: true }).catch(() => {});
  }));
}

async function saveIncomingFile(file, ext, mime) {
  const key = "namecheap-events/" + crypto.randomUUID() + "." + ext;
  const target = path.resolve(ROOT, key);
  if (target === ROOT || !target.startsWith(ROOT + path.sep)) throw new Error("invalid_storage_key");
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (file.path) {
    // The Node upload route streams to a temporary disk file; rename it into place
    // so videos never need to be copied into a giant in-memory Buffer.
    await fs.rename(file.path, target);
  } else if (file.buffer?.length) {
    await storage.put(key, file.buffer, mime);
  } else {
    throw new Error("empty_media");
  }
  const bytes = Number(file.size ?? file.buffer?.length ?? 0);
  return {
    key, bytes, mime, ext,
    name: String(file.filename || ("event." + ext)).replace(/[\\\\/\\r\\n]/g, "_").slice(0, 180)
  };
}

export default async function(req, res) {
  if (!(await requireAdminSession(req, res))) return;

  if (req.method === "GET") {
    const rows = await db.query("SELECT id,title,description,media_key,media_type,media_name,media_bytes,event_type,event_date,section_title,is_visible,audience,created_at FROM network_events ORDER BY created_at DESC,id DESC");
    const events = await Promise.all(rows.rows.map(async e => {
      const extra = await db.query("SELECT media_key,media_type,media_name FROM network_event_media WHERE event_id=$1 ORDER BY id", [e.id]);
      const media_items = [{media_key:e.media_key,media_type:e.media_type,media_name:e.media_name}, ...extra.rows];
      return {...e, media_url:await mediaUrl(e.media_key), media_items:await Promise.all(media_items.map(async m => ({...m, media_url:await mediaUrl(m.media_key)})))};
    }));
    return res.json({ok:true,events});
  }

  if (req.method === "PUT") {
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const id = Number(b.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ok:false,error:"event_id_required"});
    const title = String(b.title || "").trim(), description = String(b.description || "").trim();
    const eventType = b.event_type === "upcoming" ? "upcoming" : "past";
    const audience = b.audience === "public" ? "public" : "members";
    const sectionTitle = String(b.section_title || "").trim();
    const eventDate = b.event_date ? new Date(b.event_date) : null;
    if (!title || title.length > 180 || !description || description.length > 5000) return res.status(400).json({ok:false,error:"title_or_description_invalid"});
    if (eventDate && !Number.isFinite(eventDate.getTime())) return res.status(400).json({ok:false,error:"invalid_event_date"});
    const visible = b.is_visible !== false;
    const r = await db.query("UPDATE network_events SET title=$2,description=$3,event_type=$4,event_date=$5,section_title=$6,audience=$7,is_visible=$8,updated_at=now() WHERE id=$1 RETURNING id,title,description,event_type,event_date,section_title,audience,is_visible", [id,title,description,eventType,eventDate,sectionTitle,audience,visible]);
    if (!r.rows.length) return res.status(404).json({ok:false,error:"event_not_found"});
    return res.json({ok:true,event:r.rows[0]});
  }

  if (req.method === "DELETE") {
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const id = Number(b.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ok:false,error:"event_id_required"});
    const keys = await db.query("SELECT media_key FROM network_events WHERE id=$1 UNION ALL SELECT media_key FROM network_event_media WHERE event_id=$1", [id]);
    if (!keys.rows.length) return res.status(404).json({ok:false,error:"event_not_found"});
    await db.query("DELETE FROM network_event_media WHERE event_id=$1", [id]);
    await db.query("DELETE FROM network_events WHERE id=$1", [id]);
    await Promise.all(keys.rows.map(x => storage.del(x.media_key).catch(() => {})));
    return res.json({ok:true});
  }

  try {
    const b = req.body || {};
    const title = String(b.title || "").trim(), description = String(b.description || "").trim();
    const eventType = b.event_type === "upcoming" ? "upcoming" : "past";
    const audience = b.audience === "public" ? "public" : "members";
    const sectionTitle = String(b.section_title || "").trim();
    const eventDate = b.event_date ? new Date(b.event_date) : null;
    const files = (req.files || []).filter(f => f.field === "media");

    if (!title || title.length > 180 || !description || description.length > 5000) {
      await discardTempFiles(files);
      return res.status(400).json({ok:false,error:"title_or_description_invalid"});
    }
    if (eventDate && !Number.isFinite(eventDate.getTime())) {
      await discardTempFiles(files);
      return res.status(400).json({ok:false,error:"invalid_event_date"});
    }
    if (!files.length) return res.status(400).json({ok:false,error:"media_required"});

    const prepared = files.map(file => ({
      file,
      mime: String(file.contentType || "").toLowerCase(),
      ext: allowed.get(String(file.contentType || "").toLowerCase())
    }));
    const invalid = prepared.find(x => !x.ext || !(Number(x.file.size || x.file.buffer?.length || 0) > 0));
    if (invalid) {
      await discardTempFiles(files);
      return res.status(!invalid.ext ? 415 : 400).json({ok:false,error:!invalid.ext ? "unsupported_media_type" : "empty_media"});
    }

    const saved = [];
    let eventId = null;
    try {
      for (const item of prepared) saved.push(await saveIncomingFile(item.file, item.ext, item.mime));
      const first = saved[0];
      const r = await db.query(
        "INSERT INTO network_events(title,description,media_key,media_type,media_name,media_bytes,event_type,event_date,section_title,audience,is_visible) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE) RETURNING id,title,description,media_key,media_type,media_name,media_bytes,event_type,event_date,section_title,audience,is_visible,created_at",
        [title,description,first.key,first.mime,first.name,first.bytes,eventType,eventDate,sectionTitle,audience]
      );
      const event = r.rows[0];
      eventId = event.id;
      for (const extra of saved.slice(1)) {
        await db.query("INSERT INTO network_event_media(event_id,media_key,media_type,media_name,media_bytes) VALUES($1,$2,$3,$4,$5)", [event.id,extra.key,extra.mime,extra.name,extra.bytes]);
      }
      event.media_url = await mediaUrl(first.key);
      return res.status(201).json({ok:true,event});
    } catch (error) {
      if (eventId !== null) {
        await db.query("DELETE FROM network_event_media WHERE event_id=$1", [eventId]).catch(() => {});
        await db.query("DELETE FROM network_events WHERE id=$1", [eventId]).catch(() => {});
      }
      await Promise.all(saved.map(x => storage.del(x.key).catch(() => {})));
      await discardTempFiles(files);
      throw error;
    }
  } catch (error) {
    console.error("admin events save failed", error?.code || error?.name || "Error");
    return res.status(500).json({ok:false,error:"event_save_failed"});
  }
}
