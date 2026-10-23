import { inflateRawSync } from 'node:zlib';

/**
 * A small ZIP reader on top of zlib, enough for skill archives: stored and deflated entries, no ZIP64, no encryption.
 * It never writes to disk; the caller validates paths and sizes before anything is saved. Limits are enforced while
 * reading so a zip bomb cannot exhaust memory: an entry may not inflate beyond `maxEntryBytes` or the archive beyond
 * `maxTotalBytes`.
 */
export interface ZipEntry { path: string; data: Buffer; directory: boolean; symlink: boolean }

const EOCD = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;

export function readZip(zip: Buffer, limits: { maxEntries: number; maxEntryBytes: number; maxTotalBytes: number }): ZipEntry[] {
  // The end-of-central-directory record sits in the last 64 KiB + 22 bytes (it may be followed by a comment).
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) if (zip.readUInt32LE(i) === EOCD) { eocd = i; break; }
  if (eocd < 0) throw new Error('Không phải file .zip hợp lệ.');
  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) throw new Error('File .zip dạng ZIP64 (quá lớn) không được hỗ trợ.');
  if (count > limits.maxEntries) throw new Error(`File .zip có ${count} mục, quá giới hạn ${limits.maxEntries}.`);
  const entries: ZipEntry[] = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(offset) !== CENTRAL) throw new Error('Mục lục của file .zip bị hỏng.');
    const flags = zip.readUInt16LE(offset + 8);
    const method = zip.readUInt16LE(offset + 10);
    const compressed = zip.readUInt32LE(offset + 20);
    const size = zip.readUInt32LE(offset + 24);
    const nameLen = zip.readUInt16LE(offset + 28), extraLen = zip.readUInt16LE(offset + 30), commentLen = zip.readUInt16LE(offset + 32);
    const externalAttrs = zip.readUInt32LE(offset + 38);
    const local = zip.readUInt32LE(offset + 42);
    const name = zip.toString(flags & 0x800 ? 'utf8' : 'latin1', offset + 46, offset + 46 + nameLen).replace(/\\/g, '/');
    offset += 46 + nameLen + extraLen + commentLen;
    if (flags & 0x1) throw new Error(`"${name}" được mã hóa; không hỗ trợ file .zip có mật khẩu.`);
    // Unix mode lives in the high 16 bits; 0o120000 is a symbolic link.
    const symlink = ((externalAttrs >>> 16) & 0o170000) === 0o120000;
    const directory = name.endsWith('/');
    if (directory) { entries.push({ path: name, data: Buffer.alloc(0), directory, symlink }); continue; }
    if (size > limits.maxEntryBytes) throw new Error(`"${name}" lớn hơn ${limits.maxEntryBytes} byte.`);
    total += size;
    if (total > limits.maxTotalBytes) throw new Error(`Nội dung giải nén vượt ${limits.maxTotalBytes} byte.`);
    if (zip.readUInt32LE(local) !== LOCAL) throw new Error(`Mục "${name}" trong file .zip bị hỏng.`);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + compressed);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: limits.maxEntryBytes });
    else throw new Error(`"${name}" dùng kiểu nén ${method} chưa được hỗ trợ (chỉ stored/deflate).`);
    if (data.length !== size) throw new Error(`"${name}" giải nén ra kích thước sai; file .zip có thể bị hỏng.`);
    entries.push({ path: name, data, directory, symlink });
  }
  return entries;
}
