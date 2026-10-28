import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { buildExporter, prepareBundle } from '../../plugins/figma-exporter/build.mjs';
import { FakeRuntime, type FakeOptions } from '../../src/runtime/fake.js';
import { buildApp } from '../../src/server/app.js';
import { FigmaService } from '../../src/server/figma/service.js';
import type { FontFetch } from '../../src/server/figma/fonts.js';
import type { InstallerDeps } from '../../src/server/figma/installer.js';
import { Orchestrator } from '../../src/server/orchestrator.js';
import { Store } from '../../src/server/store.js';
import type { FigmaExportJob } from '../../src/shared/design.js';
import { FakeFigma, golden, type Golden } from './fakefigma.js';

export const PORT = 14362;
export const ORIGIN = `http://127.0.0.1:${PORT}`;
const HOST = `127.0.0.1:${PORT}`;

let templateDir: string | undefined;
/** The plugin template, built once per test process from the real source. */
export async function template(): Promise<string> {
  if (!templateDir) { templateDir = mkdtempSync(path.join(tmpdir(), 'aidept-figma-tpl-')); await buildExporter({ outDir: templateDir }); }
  return templateDir;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 20_000, what = 'điều kiện'): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`Hết thời gian chờ ${what}`);
    await sleep(25);
  }
}

export interface RigOptions { /** What the simulated agents do; lets a test see the turns and change the design folder during one. */ fake?: FakeOptions; doc?: Golden; installerDeps?: InstallerDeps; now?: () => number; chunkEvents?: boolean; uiMessageSource?: 'parent' | 'null' | 'self'; /** What the font fetcher gets instead of the network. */ fontFetch?: FontFetch }

/**
 * A whole path under test: a fake Figma document, the plugin's real built code running against it, its real UI in a DOM, and the real
 * server answering over its HTTP routes. Only Figma itself and the network are replaced.
 */
export async function rig(options: RigOptions = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'aidept-figma-'));
  const store = new Store(':memory:');
  const service = new FigmaService({ dataDir, store, port: PORT, pollMs: 150, ...(options.installerDeps ? { installerDeps: options.installerDeps } : {}), ...(options.now ? { now: options.now } : {}), ...(options.fontFetch ? { fontFetch: options.fontFetch } : {}) });
  const runtime = new FakeRuntime(options.fake ?? {});
  const orchestrator = new Orchestrator(store, () => runtime, { designs: service.inputs });
  const app = await buildApp({ store, orchestrator, dataDir, port: PORT, figma: service });
  const session = await app.inject({ url: '/api/session', headers: { host: HOST } });
  const csrf = session.json().token as string;
  const admin = {
    get: (url: string) => app.inject({ method: 'GET', url, headers: { host: HOST } }),
    post: (url: string, payload: unknown = {}) => app.inject({ method: 'POST', url, headers: { host: HOST, 'x-csrf-token': csrf }, payload: payload as object }),
    delete: (url: string) => app.inject({ method: 'DELETE', url, headers: { host: HOST, 'x-csrf-token': csrf } }),
  };
  const bundleDir = path.join(dataDir, 'bundle');
  const info = prepareBundle({ templateDir: await template(), outDir: bundleDir, origin: ORIGIN });
  const doc = options.doc ?? golden();
  const figma = doc.figma;

  // The plugin's main code, in the same realm as the fake Figma, exactly as the build produced it.
  const code = readFileSync(path.join(bundleDir, 'code.js'), 'utf8');
  const html = readFileSync(path.join(bundleDir, 'ui.html'), 'utf8');
  new Function('figma', '__html__', code)(figma, html);

  // Its UI, in a DOM. `parent` is the main code, and fetch goes straight to the server.
  const trace: string[] = [];
  const kind = (m: unknown) => { const x = m as { type?: string; event?: { type?: string } }; return x.type === 'EVENT' ? `EVENT:${x.event?.type}` : String(x.type); };
  const stubParent = { postMessage: (m: { pluginMessage: unknown }) => { trace.push(`ui→main ${kind(m.pluginMessage)}`); setTimeout(() => figma.ui.onmessage?.(m.pluginMessage), 0); } };
  const fetches: { path: string; status: number }[] = [];
  const dom = new JSDOM(figma.uiHtml, {
    runScripts: 'dangerously', url: 'http://localhost/', pretendToBeVisual: true,
    beforeParse(window: Record<string, unknown>) {
      Object.defineProperty(window, 'parent', { value: stubParent, configurable: true });
      (window as unknown as { fetch: unknown }).fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
        const u = new URL(url);
        const res = await app.inject({ method: init.method as 'POST', url: u.pathname + u.search, headers: { ...init.headers, host: HOST, origin: 'null' }, payload: init.body });
        fetches.push({ path: u.pathname, status: res.statusCode });
        return { ok: res.statusCode < 400, status: res.statusCode, text: async () => res.body };
      };
    },
  });
  figma.outbound = (message) => setTimeout(() => {
    trace.push(`main→ui ${kind(message)}`);
    const event = new dom.window.MessageEvent('message', { data: { pluginMessage: message } });
    Object.defineProperty(event, 'source', { value: options.uiMessageSource === 'null' ? null : options.uiMessageSource === 'self' ? dom.window : stubParent });
    dom.window.dispatchEvent(event);
  }, 0);

  const ui = {
    status: () => dom.window.document.getElementById('status')!.textContent ?? '',
    detail: () => dom.window.document.getElementById('detail')!.textContent ?? '',
    view: () => dom.window.document.getElementById('view')!.getAttribute('data-view'),
    type(code: string) { (dom.window.document.getElementById('code') as HTMLInputElement).value = code; },
    click(id: string) { (dom.window.document.getElementById(id) as HTMLElement).click(); },
  };

  const pairNow = async (): Promise<void> => {
    const code = (await admin.post('/api/integrations/figma/pairing')).json().code as string;
    ui.type(code); ui.click('pair');
    await waitFor(() => service.hub.connectionState().state === 'connected', 10_000, 'ghép đôi');
  };
  const job = (id: string): FigmaExportJob => service.hub.getJob(id);
  const exportAs = async (body: Record<string, unknown>): Promise<FigmaExportJob> => {
    const r = await admin.post('/api/design-exports', body);
    if (r.statusCode !== 202) throw new Error(`Tạo export thất bại ${r.statusCode}: ${r.body}`);
    return r.json() as FigmaExportJob;
  };
  const finished = (id: string, ms = 30_000) => waitFor(() => { const j = job(id); return !['queued', 'preparing', 'inventory', 'reading', 'dependencies', 'assets', 'verifying', 'assembling'].includes(j.status) ? j : undefined; }, ms, 'export kết thúc');

  const dispose = async () => {
    service.hub.disconnect();
    await sleep(300);
    dom.window.close();
    await app.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  return { trace, runtime, dataDir, store, service, orchestrator, app, admin, figma, doc, ui, info, pairNow, exportAs, job, finished, dispose, fetches, dom, FakeFigma };
}
