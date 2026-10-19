import { storage, config } from 'hatchable';
import crypto from 'node:crypto';

export const methods = ['POST'];
export const access = 'public';

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = new Set(['application/json','application/zip','application/x-zip-compressed','text/csv','text/plain','application/octet-stream']);

export default async function (req, res) {
  let expectedToken = '';
  try { expectedToken = String(await config.get('TEMP_SOURCE_UPLOAD_TOKEN') || ''); } catch {}
  const suppliedToken = String(req.query?.token || '');
  const expectedBytes = Buffer.from(expectedToken);
  const suppliedBytes = Buffer.from(suppliedToken);
  if (expectedBytes.length < 32 || expectedBytes.length !== suppliedBytes.length || !crypto.timingSafeEqual(expectedBytes, suppliedBytes)) return res.status(404).json({ error: 'Not found' });
  const file = (req.files || []).find(f => f.field === 'file');
  if (!file) return res.status(400).json({ error: 'لم يتم اختيار ملف.' });
  if (!file.buffer || file.buffer.length > MAX_BYTES) return res.status(413).json({ error: 'الحد الأقصى لحجم الملف 10 ميجابايت.' });
  const filename = String(file.filename || 'source-file').split(/[\\/]/).pop().slice(0, 120);
  const ext = (filename.includes('.') ? filename.split('.').pop() : 'bin').toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,8) || 'bin';
  const contentType = ALLOWED.has(file.contentType) ? file.contentType : 'application/octet-stream';
  const key = 'temporary-source-upload/' + Date.now() + '-' + crypto.randomUUID() + '.' + ext;
  await storage.put(key, file.buffer, contentType, {
    metadata: { filename: encodeURIComponent(filename).slice(0, 500), purpose: 'temporary-name-repair-source', uploaded_by: 'project-owner' }
  });
  console.log('Temporary source file received:', key, file.buffer.length, contentType);
  return res.status(200).json({ ok: true, filename, bytes: file.buffer.length, message: 'Upload stored privately.' });
}