import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const EXTENSIONS = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["video/mp4", "mp4"],
  ["video/webm", "webm"],
  ["video/quicktime", "mov"]
]);

function cleanName(value, fallback) {
  return String(value || fallback)
    .replaceAll("/", "_")
    .replaceAll("\\", "_")
    .replace(/[\r\n]/g, "_")
    .slice(0, 180);
}

function uploadDirectory(tempRoot, uploadId) {
  if (!UUID.test(String(uploadId || ""))) throw new Error("invalid_upload_id");
  const root = path.resolve(tempRoot);
  const directory = path.resolve(root, String(uploadId));
  if (!directory.startsWith(root + path.sep)) throw new Error("invalid_upload_path");
  return directory;
}

export async function saveEventUploadChunk({ tempRoot, uploadId, index, bytes, maxChunkBytes }) {
  if (!UUID.test(String(uploadId || ""))) throw new Error("invalid_upload_id");
  if (!Number.isSafeInteger(index) || index < 0 || index > 10000) throw new Error("invalid_chunk_index");
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > maxChunkBytes) throw new Error("invalid_chunk_size");

  const directory = uploadDirectory(tempRoot, uploadId);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, index + ".part");
  const temporary = path.join(directory, "." + index + "." + crypto.randomUUID() + ".tmp");
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return { ok: true, index, bytes: bytes.length };
}

export async function finalizeLocalEventUpload({
  tempRoot, storageRoot, uploadId, chunks, bytes, contentType, name, maxChunkBytes
}) {
  if (!UUID.test(String(uploadId || ""))) throw new Error("invalid_upload_id");
  const count = Number(chunks);
  const expectedBytes = Number(bytes);
  const mime = String(contentType || "").split(";")[0].trim().toLowerCase();
  const ext = EXTENSIONS.get(mime);
  if (!Number.isSafeInteger(count) || count < 1 || count > 10001) throw new Error("invalid_chunk_count");
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1) throw new Error("invalid_media_size");
  if (!ext) throw new Error("unsupported_media_type");

  const root = path.resolve(storageRoot);
  const mediaDirectory = path.resolve(root, "namecheap-events");
  const key = "namecheap-events/" + uploadId + "." + ext;
  const target = path.resolve(root, key);
  if (!target.startsWith(mediaDirectory + path.sep)) throw new Error("invalid_storage_key");
  await fs.mkdir(mediaDirectory, { recursive: true, mode: 0o700 });

  // A retry after a lost response returns the same completed file.
  try {
    const existing = await fs.stat(target);
    if (existing.isFile() && existing.size === expectedBytes) {
      await fs.rm(uploadDirectory(tempRoot, uploadId), { recursive: true, force: true }).catch(() => {});
      return { key, type: mime, name: cleanName(name, "event." + ext), bytes: existing.size };
    }
    throw new Error("upload_key_conflict");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const directory = uploadDirectory(tempRoot, uploadId);
  const temporary = target + ".incoming-" + crypto.randomUUID();
  let handle;
  let total = 0;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    for (let index = 0; index < count; index++) {
      const partPath = path.join(directory, index + ".part");
      let part;
      try {
        part = await fs.readFile(partPath);
      } catch (error) {
        if (error?.code === "ENOENT") throw new Error("missing_upload_chunk:" + index);
        throw error;
      }
      if (!part.length || part.length > maxChunkBytes) throw new Error("invalid_upload_chunk:" + index);
      const position = total;
      total += part.length;
      if (total > expectedBytes) throw new Error("uploaded_size_exceeds_expected");
      let offset = 0;
      while (offset < part.length) {
        const result = await handle.write(part, offset, part.length - offset, position + offset);
        if (!result.bytesWritten) throw new Error("event_media_write_failed");
        offset += result.bytesWritten;
      }
    }
    if (total !== expectedBytes) throw new Error("uploaded_size_mismatch");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, target);
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    return { key, type: mime, name: cleanName(name, "event." + ext), bytes: total };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
