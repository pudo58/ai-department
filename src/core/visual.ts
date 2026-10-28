import { PNG } from 'pngjs';

const MAX_PIXELS = 16_000_000;
/** Bound allocation before decoding; neither an invalid PNG nor an oversized input counts as a match. */
export function readPng(buffer: Buffer): PNG {
  if (buffer.length > 64 * 1024 * 1024 || buffer.length < 33 || buffer.toString('hex', 0, 8) !== '89504e470d0a1a0a' || buffer.readUInt32BE(8) !== 13 || buffer.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Ảnh PNG không hợp lệ hoặc quá lớn.');
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  if (!width || !height || width * height > MAX_PIXELS) throw new Error('Ảnh vượt giới hạn 16 triệu pixel.');
  return PNG.sync.read(buffer);
}

/** Compare fixed-size, sRGB captures. Alpha is composited on white; magenta marks pixels above the configured channel tolerance. */
export function comparePng(reference: Buffer, actual: Buffer, threshold: number) {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('Ngưỡng pixel phải từ 0 đến 1.');
  const a = readPng(reference), b = readPng(actual);
  if (a.width !== b.width || a.height !== b.height) throw new Error(`Kích thước khác nhau: Figma ${a.width}×${a.height}, app ${b.width}×${b.height}.`);
  const diff = new PNG({ width: a.width, height: a.height });
  let changedPixels = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    let delta = 0;
    for (let c = 0; c < 3; c++) {
      const left = a.data[i + c]! * a.data[i + 3]! / 255 + 255 - a.data[i + 3]!;
      const right = b.data[i + c]! * b.data[i + 3]! / 255 + 255 - b.data[i + 3]!;
      delta = Math.max(delta, Math.abs(left - right) / 255);
    }
    if (delta > threshold) { changedPixels++; diff.data.set([230, 0, 150, 255], i); }
    else { const gray = Math.round((b.data[i]! + b.data[i + 1]! + b.data[i + 2]!) / 3); diff.data.set([gray, gray, gray, 100], i); }
  }
  const totalPixels = a.width * a.height;
  return { changedPixels, totalPixels, changedRatio: changedPixels / totalPixels, diff: PNG.sync.write(diff) };
}
