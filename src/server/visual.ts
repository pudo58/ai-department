import { chromium, type Browser } from 'playwright-core';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { changedInBox, readPng } from '../core/visual.js';
import { VisualComparator } from './visualcompare.js';
import { visualProfileHash, visualProfileOf } from '../core/visualevidence.js';
import { DOM_TEXT_SCRIPT, compareText, figmaTextRuns, type DomTextRun } from '../core/designtext.js';
import type { NodeRecord } from '../shared/figma.js';
import { sha256 } from '../core/contract.js';
import type { Run } from '../shared/types.js';
import type { VisualReport, VisualScreenResult } from '../shared/visual.js';
import type { SnapshotPreview } from '../shared/design.js';
import { GitWorkspaces } from '../runtime/gitworkspace.js';
import { PreviewManager, guessPreviewCommand } from './preview.js';
import type { SnapshotStore } from './figma/snapshots.js';

/** Prefer an installed compatible browser. Nothing is downloaded, and the app's credentials are never reused. */
async function launchBrowser(): Promise<Browser> {
  try { return await chromium.launch({ headless: true, timeout: 30000 }); }
  catch (error) { if (!/Executable doesn't exist/.test((error as Error).message)) throw error; }
  const executable = [chromium.executablePath(), ...(process.platform === 'win32' ? [
    path.join(process.env.PROGRAMFILES ?? 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
  ] : [])].find(p => existsSync(p));
  if (!executable) throw new Error('Chưa có Chromium/Chrome/Edge để kiểm tra hình ảnh. Cài trình duyệt rồi chạy lại; không cần sửa code dự án.');
  return chromium.launch({ headless: true, executablePath: executable, timeout: 30000 });
}

/**
 * A text box in which fewer of the pixels differ than this looks the same in both images, whatever the DOM says: Figma lists text that another
 * layer covers and the page need not draw it. On one real design (a 98%-by-pixels build) the covered or identical text sat at 2–12% changed
 * pixels and every real difference at 19% or more; 15% sits between them. One design is not a calibration.
 */
const MIN_CHANGED_IN_TEXT_BOX = 0.15;

/** Capture the exact committed source in a disposable clone, then compare against immutable Figma screen images. */
export class VisualChecks {
  constructor(private readonly dataDir: string, private readonly snapshots: SnapshotStore) {}

  async run(run: Run, signal: AbortSignal): Promise<VisualReport | undefined> {
    const profile = visualProfileOf(run), binding = run.contract.design;
    if (!profile || !binding || !run.checkpoint || run.provider === 'fake') return;
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(5 * 60000)]);
    const id = `vis_${randomUUID().replaceAll('-', '')}`;
    const dir = path.join(this.dataDir, 'visual-checks', run.id, id);
    const report: VisualReport = { schemaVersion: 1, source: 'harness', id, runId: run.id, checkpoint: run.checkpoint,
      slot: run.selectedSlot, contractVersion: run.contract.version, snapshotId: binding.snapshotId, snapshotHash: binding.snapshotHash,
      profileHash: visualProfileHash(profile), profile, status: 'incomplete', startedAt: new Date().toISOString(), endedAt: '', screens: [],
      artifactDir: dir,
      limitations: ['So ảnh đo khác biệt pixel, không chứng minh toàn bộ hành vi hoặc ngữ nghĩa.', `Bỏ qua chênh màu tối đa ${(profile.pixelThreshold * 100).toFixed(1)}% mỗi kênh; cùng quy tắc được dùng để kiểm tra ổn định giữa ba lượt.`, 'Font và cách render của trình duyệt có thể khác Figma; đọc ảnh sai lệch trước khi quyết định.'] };
    let browser: Browser | undefined;
    let comparator: VisualComparator | undefined;
    const previews = new PreviewManager(5 * 60000);
    const closeBrowser = () => { void browser?.close().catch(() => undefined); };
    bounded.addEventListener('abort', closeBrowser, { once: true });
    try {
      if (run.configSnapshot.executionMode !== 'local') throw new Error('Kiểm tra hình ảnh hiện hỗ trợ runtime local; chưa có browser runner Docker.');
      this.snapshots.usable(binding);
      const reader = this.snapshots.reader(binding.snapshotId);
      const ids = new Set((binding.targetIds.length ? binding.targetIds : reader.roots.map(r => r.id)).flatMap(id => reader.subtree(id).map(r => r.id)));
      const available = this.snapshots.previews(binding.snapshotId).images.filter(p => p.role === 'screen' && ids.has(p.nodeId));
      if (profile.screens?.some(s => !available.some(p => p.nodeId === s.nodeId))) throw new Error('Profile tham chiếu node không có ảnh screen trong target của task.');
      const screens = profile.screens ? available.filter(s => profile.screens!.some(m => m.nodeId === s.nodeId)) : available;
      if (screens.length !== available.length) report.limitations.push(`Profile chọn ${screens.length}/${available.length} ảnh screen; các ảnh ngoài profile chưa được kiểm chứng: ${available.filter(s => !screens.some(p => p.nodeId === s.nodeId)).map(s => s.nodeId).join(', ')}.`);
      if (!screens.length) throw new Error('Snapshot không có ảnh screen trong phạm vi. Cần export ảnh từng màn hình trước khi so hình thức.');
      if (screens.length > 30) throw new Error('Phạm vi có hơn 30 màn hình; chọn target nhỏ hơn để kiểm tra đầy đủ, không cắt ảnh âm thầm.');
      await mkdir(dir, { recursive: true });
      browser = await launchBrowser(); report.browser = browser.version();
      comparator = new VisualComparator();
      bounded.throwIfAborted();
      const ws = new GitWorkspaces(this.dataDir);
      await ws.withTrialClone(run, run.selectedSlot, '', async cwd => {
        await ws.linkDependencies(run, run.selectedSlot, cwd);
        const command = run.configSnapshot.previewCommand?.length ? run.configSnapshot.previewCommand : await guessPreviewCommand(cwd);
        if (!command) throw new Error('Chưa có lệnh chạy ứng dụng. Cấu hình Lệnh chạy thử trong project.');
        const preview = await previews.start(id, cwd, command);
        try {
          for (const screen of screens) {
            bounded.throwIfAborted();
            report.screens.push(await this.screen(run, screen, browser!, preview.url, dir, bounded, comparator!));
          }
        } finally { previews.stopAll(); }
      }, bounded);
      this.snapshots.usable(binding);
      report.status = report.screens.some(s => s.status === 'incomplete' || s.status === 'unstable') ? 'incomplete' : report.screens.every(s => s.status === 'passed') ? 'passed' : 'needs_review';
      if (profile.maxDiffRatio === undefined) report.limitations.push('Chưa cấu hình ngưỡng sai lệch chấp nhận: chỉ đo và chỉ vị trí khác, chưa tự kết luận khớp.');
    } catch (error) { report.status = 'incomplete'; report.limitations.push((error as Error).message); }
    finally { previews.stopAll(); bounded.removeEventListener('abort', closeBrowser); await browser?.close().catch(() => undefined); await comparator?.close(); report.endedAt = new Date().toISOString(); }
    if (signal.aborted) throw new Error('Kiểm tra hình ảnh bị hủy.');
    return report;
  }

  /** The text nodes of this screen in the snapshot against the text the page rendered. Nothing is checked when the snapshot has none. */
  private textCheck(run: Run, nodeId: string, dom: readonly DomTextRun[], widget: boolean, diff: ReturnType<typeof readPng>, scale: number) {
    const reader = this.snapshots.reader(run.contract.design!.snapshotId), screen = reader.node(nodeId);
    if (!screen) return undefined;
    const nodes = reader.subtree(nodeId).map(r => reader.node(r.id)).filter((n): n is NodeRecord => !!n);
    const figma = figmaTextRuns(nodes, screen);
    return figma.length ? compareText(figma, dom, { position: !widget, differs: f => !f.box || changedInBox(diff, f.box, scale) >= MIN_CHANGED_IN_TEXT_BOX }) : undefined;
  }

  private async screen(run: Run, screen: SnapshotPreview, browser: Browser, origin: string, dir: string, signal: AbortSignal, comparator: VisualComparator): Promise<VisualScreenResult> {
    const profile = visualProfileOf(run)!;
    const route = profile.pathTemplate.replaceAll('{nodeId}', encodeURIComponent(screen.nodeId));
    const result: VisualScreenResult = { nodeId: screen.nodeId, name: screen.name, route, width: 0, height: 0, status: 'incomplete', message: '' };
    try {
      const reference = await readFile(this.snapshots.file(run.contract.design!.snapshotId, screen.fileId).full);
      const png = readPng(reference), scale = screen.scale ?? 1;
      const mapping = profile.screens?.find(s => s.nodeId === screen.nodeId);
      if (!Number.isFinite(scale) || scale <= 0 || scale > 4) throw new Error('Tỉ lệ ảnh screen không hợp lệ.');
      const width = mapping?.viewport?.width ?? Math.round(png.width / scale), height = mapping?.viewport?.height ?? Math.round(png.height / scale);
      if (width > 4096 || height > 4096 || width < 100 || height < 100) throw new Error('Ảnh screen không phù hợp viewport (100–4096px); cần ảnh màn hình đầy đủ đúng tỉ lệ.');
      Object.assign(result, { width, height, referenceHash: sha256(reference.toString('base64')) });
      const filename = `screen-${screen.nodeId.replaceAll(':', '-')}`;
      const asset = (suffix: string) => `${filename}-${suffix}.png`;
      await writeFile(path.join(dir, asset('reference')), reference); result.reference = asset('reference');
      const captures: Buffer[] = [];
      let domText: DomTextRun[] = [];
      for (let i = 0; i < 3; i++) {
        signal.throwIfAborted();
        const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, reducedMotion: 'reduce', colorScheme: 'light', serviceWorkers: 'block' });
        try {
          await context.route('**/*', r => { const url = new URL(r.request().url()); return url.origin === origin || ['data:', 'blob:'].includes(url.protocol) ? r.continue() : r.abort(); });
          const page = await context.newPage(); page.setDefaultTimeout(15000);
          const errors: string[] = [];
          page.on('pageerror', e => errors.push(e.message));
          page.on('response', r => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
          const response = await page.goto(new URL(route, origin).href, { waitUntil: 'networkidle', timeout: 20000 });
          if (!response?.ok()) throw new Error(`Màn hình trả HTTP ${response?.status() ?? 'không xác định'}.`);
          if (profile.readySelector) await page.locator(profile.readySelector).waitFor();
          await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(img => img.decode())); });
          await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          const options = { animations: 'disabled' as const, caret: 'hide' as const, timeout: 30000 };
          captures.push(await (mapping?.selector ? page.locator(mapping.selector).screenshot(options) : page.screenshot(options)));
          if (i === 0) domText = await page.evaluate(DOM_TEXT_SCRIPT) as DomTextRun[];
          if (errors.length) throw new Error(`Ứng dụng có lỗi khi chụp: ${errors.slice(0, 3).join('; ')}`);
        } finally { await context.close(); }
      }
      const actual = captures[0]!;
      await writeFile(path.join(dir, asset('actual')), actual); result.actual = asset('actual'); result.actualHash = sha256(actual.toString('base64'));
      const repeats = await Promise.all(captures.slice(1).map(c => comparator.compare(actual, c, profile.pixelThreshold)));
      if (repeats.some(r => r.changedPixels > 0)) {
        const worst = repeats.reduce((a, b) => a.changedPixels > b.changedPixels ? a : b);
        result.stabilityRatio = worst.changedRatio;
        result.stabilityDiff = asset('stability'); await writeFile(path.join(dir, result.stabilityDiff), worst.diff);
        result.repeats = [asset('repeat-2'), asset('repeat-3')];
        await Promise.all(result.repeats.map((file, i) => writeFile(path.join(dir, file), captures[i + 1]!)));
        result.status = 'unstable'; result.message = 'Ba lần tải mới cho ảnh khác nhau; chưa dùng làm bằng chứng khớp.'; return result;
      }
      const actualPng = readPng(actual);
      if (actualPng.width !== png.width || actualPng.height !== png.height) {
        result.status = 'different'; result.message = `Kích thước khác nhau: Figma ${png.width}×${png.height}, app ${actualPng.width}×${actualPng.height}.`; return result;
      }
      const measured = await comparator.compare(reference, actual, profile.pixelThreshold);
      await writeFile(path.join(dir, asset('diff')), measured.diff); result.diff = asset('diff');
      Object.assign(result, { changedRatio: measured.changedRatio, changedPixels: measured.changedPixels, totalPixels: measured.totalPixels });
      result.text = this.textCheck(run, screen.nodeId, domText, !!mapping?.selector, readPng(measured.diff), scale);
      const textNote = result.text?.mismatches.length ? ` Chữ và kiểu chữ lệch ${result.text.mismatches.length + result.text.omitted}/${result.text.figmaTexts} đoạn so với Figma.` : '';
      if (profile.maxDiffRatio === undefined) {
        result.status = 'needs_review'; result.message = `Ảnh ổn định qua ba lần; chưa có ngưỡng chấp nhận để tự kết luận.${textNote}`;
      } else {
        // A page a few pixels away from the image can still say another number or use another font: the text check decides that too.
        result.status = measured.changedRatio <= profile.maxDiffRatio && !result.text?.mismatches.length ? 'passed' : 'different';
        result.message = result.status === 'passed' ? 'Ba ảnh ổn định, sai lệch nằm trong ngưỡng profile và chữ khớp Figma.' : `${measured.changedRatio > profile.maxDiffRatio ? 'Sai lệch vượt ngưỡng profile; xem vùng màu hồng trong ảnh diff.' : 'Pixel trong ngưỡng nhưng chữ hoặc kiểu chữ khác Figma.'}${textNote}`;
      }
    } catch (error) { result.status = 'incomplete'; result.message = (error as Error).message; }
    return result;
  }
}
