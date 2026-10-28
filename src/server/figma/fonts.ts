import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fontFaceCss, fontsourceId } from '../../core/designfonts.js';
import { sha256Hex } from '../../core/design.js';
import { FONT_HOSTS, FONT_SUBSETS, type FontFamilyResult, type FontFile, type FontSet, type FontUse } from '../../shared/fonts.js';

const MAX_FAMILIES = 12;
const MAX_FILES = 80;
const MAX_FILE_BYTES = 1_000_000;
const TIMEOUT_MS = 30_000;
const VERSION = /^\d+\.\d+\.\d+$/;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** What is kept of the fonts fetched for a snapshot: the files by content in one folder, and one small record per snapshot. Never inside a snapshot, which is immutable. */
export class FontStore {
  constructor(private readonly dataDir: string) {}
  private get root(): string { return path.join(this.dataDir, 'design-fonts'); }
  private setPath(snapshotId: string): string { return path.join(this.root, 'sets', `${snapshotId.replace(/[^a-zA-Z0-9_-]/g, '')}.json`); }

  read(snapshotId: string, snapshotHash?: string): FontSet | undefined {
    try {
      const set = JSON.parse(readFileSync(this.setPath(snapshotId), 'utf8')) as FontSet;
      return set.schemaVersion === 1 && set.snapshotId === snapshotId && (snapshotHash === undefined || set.snapshotHash === snapshotHash) ? set : undefined;
    } catch { return undefined; }
  }
  write(set: FontSet): void {
    const target = this.setPath(set.snapshotId);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(`${target}.tmp`, JSON.stringify(set, null, 1)); renameSync(`${target}.tmp`, target);
  }
  /** A stored file, by the relative name a record holds. Nothing outside the folder, whatever the record says. */
  file(rel: string): string {
    const full = path.resolve(this.root, 'files', rel);
    if (!full.startsWith(path.resolve(this.root, 'files') + path.sep)) throw new Error('Đường dẫn font không hợp lệ.');
    return full;
  }
  /** Changes when the set does, so a run's copy of the design is rebuilt once the fonts for its snapshot are fetched. */
  hashFor(snapshotId: string, snapshotHash: string): string {
    const set = this.read(snapshotId, snapshotHash);
    return set ? sha256Hex(JSON.stringify(set.families.map((f) => [f.family, f.status, f.files.map((x) => x.sha256)]))) : '';
  }
  css(set: FontSet): string { return fontFaceCss(set.families); }
}

export type FontFetch = (url: string, init: { signal: AbortSignal; redirect: 'error'; headers: Record<string, string> }) => Promise<Response>;

/**
 * Fetches open fonts for the families a design uses. Only the hosts in FONT_HOSTS, https only, no redirects, a size cap on every file, the
 * WOFF2 signature checked, and a hash kept of everything stored. A family the catalogue does not have is reported as missing, not replaced.
 */
export class FontFetcher {
  constructor(private readonly store: FontStore, private readonly fetchFn: FontFetch = (url, init) => fetch(url, init)) {}

  private async get(url: string, signal: AbortSignal): Promise<Response> {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !(FONT_HOSTS as readonly string[]).includes(u.hostname)) throw new Error(`Host không nằm trong danh sách cho phép: ${u.hostname}`);
    return this.fetchFn(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]), redirect: 'error', headers: { Accept: '*/*', 'User-Agent': 'ai-department-font-fetch' } });
  }

  async fetchFor(snapshot: { id: string; snapshotHash: string }, uses: readonly FontUse[], signal: AbortSignal): Promise<FontSet> {
    const families: FontFamilyResult[] = [];
    let files = 0;
    for (const use of uses.slice(0, MAX_FAMILIES)) {
      signal.throwIfAborted();
      const result = await this.family(use, signal, () => files, (n) => { files += n; });
      families.push(result);
    }
    if (uses.length > MAX_FAMILIES) for (const use of uses.slice(MAX_FAMILIES)) families.push({ family: use.family, status: 'failed', files: [], notes: [`Bỏ qua: chỉ tải tối đa ${MAX_FAMILIES} họ font một lần.`] });
    const set: FontSet = { schemaVersion: 1, snapshotId: snapshot.id, snapshotHash: snapshot.snapshotHash, fetchedAt: new Date().toISOString(), families };
    this.store.write(set);
    return set;
  }

  private async family(use: FontUse, signal: AbortSignal, fileCount: () => number, addFiles: (n: number) => void): Promise<FontFamilyResult> {
    const id = fontsourceId(use.family), base: FontFamilyResult = { family: use.family, status: 'failed', files: [], notes: [] };
    if (!ID.test(id)) return { ...base, notes: ['Tên họ font không tra được trong kho.'] };
    let meta: { id?: unknown; npmVersion?: unknown; license?: unknown; source?: unknown; subsets?: unknown; weights?: unknown; styles?: unknown; unicodeRange?: unknown };
    try {
      const response = await this.get(`https://api.fontsource.org/v1/fonts/${id}`, signal);
      if (response.status === 404) return { ...base, status: 'not_open', notes: ['Không có trong kho font mã nguồn mở (fontsource). Có thể là font thương mại: cần bạn cung cấp file font hợp lệ.'] };
      if (!response.ok) return { ...base, notes: [`Kho font trả HTTP ${response.status}.`] };
      meta = await response.json() as typeof meta;
    } catch (error) { return { ...base, notes: [`Không tra được kho font: ${(error as Error).message}`] }; }
    const version = meta.npmVersion, weights = meta.weights, subsets = meta.subsets, styles = meta.styles;
    if (meta.id !== id || typeof version !== 'string' || !VERSION.test(version) || !Array.isArray(weights) || !Array.isArray(subsets) || !Array.isArray(styles)) return { ...base, notes: ['Kho font trả dữ liệu không đúng định dạng.'] };
    const license = typeof meta.license === 'string' ? meta.license.slice(0, 40) : undefined, source = typeof meta.source === 'string' && meta.source.startsWith('https://') ? meta.source.slice(0, 200) : undefined;
    const wanted = FONT_SUBSETS.filter((s) => subsets.includes(s));
    if (!wanted.includes('latin')) return { ...base, id, version, ...(license ? { license } : {}), notes: ['Họ font không có bản latin.'] };
    const numeric = weights.filter((w): w is number => typeof w === 'number');
    const notes: string[] = [], out: FontFile[] = [], seen = new Set<string>();
    for (const variant of use.variants) {
      const weight = numeric.length ? numeric.reduce((a, b) => (Math.abs(b - variant.weight) < Math.abs(a - variant.weight) ? b : a)) : variant.weight;
      if (weight !== variant.weight) notes.push(`Độ đậm ${variant.weight} không có; dùng ${weight}.`);
      const italic = variant.italic && styles.includes('italic');
      if (variant.italic && !italic) notes.push(`Kiểu nghiêng của độ đậm ${variant.weight} không có; dùng kiểu thường.`);
      for (const subset of wanted) {
        const name = `${id}-${subset}-${weight}-${italic ? 'italic' : 'normal'}.woff2`;
        if (seen.has(name)) continue; seen.add(name);
        if (fileCount() + out.length >= MAX_FILES) { notes.push('Đạt giới hạn số file font; phần còn lại bị bỏ qua.'); break; }
        try {
          const file = await this.download(id, version, name, signal);
          if (file) out.push({ file: `${id}@${version}/${name}`, name, family: use.family, weight, italic, subset, sha256: file.sha256, bytes: file.bytes });
          else notes.push(`Không có file ${name} trong kho.`);
        } catch (error) { notes.push(`Không tải được ${name}: ${(error as Error).message}`); }
      }
    }
    addFiles(out.length);
    const hasLatin = out.some((f) => f.subset === 'latin');
    const unicodeRange = meta.unicodeRange && typeof meta.unicodeRange === 'object' ? Object.fromEntries(Object.entries(meta.unicodeRange as Record<string, unknown>).filter(([k, v]) => (FONT_SUBSETS as readonly string[]).includes(k) && typeof v === 'string')) as Record<string, string> : undefined;
    return { family: use.family, status: hasLatin ? 'ready' : 'failed', id, version, ...(license ? { license } : {}), ...(source ? { source } : {}), files: out, notes, ...(unicodeRange ? { unicodeRange } : {}) };
  }

  /** One WOFF2 file: reused when it is already stored, otherwise fetched, checked and written. Undefined when the catalogue has no such file. */
  private async download(id: string, version: string, name: string, signal: AbortSignal): Promise<{ sha256: string; bytes: number } | undefined> {
    const target = this.store.file(`${id}@${version}/${name}`);
    if (existsSync(target)) { const bytes = readFileSync(target); return { sha256: sha256Hex(bytes), bytes: bytes.length }; }
    const response = await this.get(`https://cdn.jsdelivr.net/npm/@fontsource/${id}@${version}/files/${name}`, signal);
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > MAX_FILE_BYTES) throw new Error('file quá lớn');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) throw new Error('kích thước không hợp lệ');
    if (bytes.subarray(0, 4).toString('latin1') !== 'wOF2') throw new Error('không phải file WOFF2');
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(`${target}.tmp`, bytes); renameSync(`${target}.tmp`, target);
    return { sha256: sha256Hex(bytes), bytes: bytes.length };
  }
}
