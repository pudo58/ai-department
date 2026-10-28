import path from 'node:path';
import type { DesignBinding, IntegrationSummary } from '../../shared/design.js';
import { HttpError } from '../run/support.js';
import type { Store } from '../store.js';
import { ExporterHub } from './exporter.js';
import { FigmaInstaller, type InstallerDeps } from './installer.js';
import { SnapshotStore } from './snapshots.js';
import { DesignInputs } from './designinput.js';
import { FontFetcher, FontStore, type FontFetch } from './fonts.js';
import { fontUses } from '../../core/designfonts.js';
import { FONT_HOSTS, type FontSet, type SnapshotFonts } from '../../shared/fonts.js';

export interface FigmaServiceOptions {
  dataDir: string; store: Store; port: number;
  installerDeps?: InstallerDeps; now?: () => number; pollMs?: number;
  /** Tests give a fake; production fetches over the network, from the hosts in FONT_HOSTS only. */
  fontFetch?: FontFetch;
}

/** Everything the Figma integration is made of, built once per server: the plugin hub, the installer, the snapshots and the task inputs. */
export class FigmaService {
  readonly snapshots: SnapshotStore;
  readonly hub: ExporterHub;
  readonly installer: FigmaInstaller;
  readonly inputs: DesignInputs;
  readonly fonts: FontStore;
  private readonly fontFetcher: FontFetcher;
  readonly origin: string;

  constructor(private readonly o: FigmaServiceOptions) {
    this.origin = `http://127.0.0.1:${o.port}`;
    this.snapshots = new SnapshotStore(o.dataDir, o.store);
    this.hub = new ExporterHub({ dataDir: o.dataDir, store: o.store, snapshots: this.snapshots, ...(o.now ? { now: o.now } : {}), ...(o.pollMs ? { pollMs: o.pollMs } : {}) });
    this.installer = new FigmaInstaller({ dataDir: o.dataDir, store: o.store, origin: this.origin, ...(o.installerDeps ? { deps: o.installerDeps } : {}) });
    this.fonts = new FontStore(o.dataDir);
    this.fontFetcher = new FontFetcher(this.fonts, o.fontFetch);
    this.inputs = new DesignInputs(o.dataDir, this.snapshots, this.fonts);
  }

  /** Closes what a restart cannot continue and starts watching the live session. */
  start(): void {
    this.hub.recover();
    this.installer.recover();
    this.hub.start();
  }
  stop(): void { this.hub.stop(); }

  async summary(): Promise<IntegrationSummary> {
    const [desktop] = await Promise.all([this.installer.desktopState()]);
    const connection = this.hub.connectionState();
    const active = this.installer.activeJob();
    return {
      id: 'figma-desktop', label: 'Figma Desktop · Kết nối trực tiếp', adapter: 'figma-direct', badge: 'Desktop · Trực tiếp',
      desktop, bundle: this.installer.bundleState(), connection,
      ...(active ? { activeInstallJobId: active.id } : {}), ...(connection.activeJobId ? { activeExportJobId: connection.activeJobId } : {}),
      platform: this.installer.platformSupport(),
    };
  }

  /** The fonts the text of a snapshot uses, and what was fetched for them, if anything. Reads only; nothing is fetched. */
  fontsOf(snapshotId: string): SnapshotFonts {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) throw new HttpError(404, 'Snapshot không tồn tại.');
    const reader = this.snapshots.reader(snapshotId);
    const texts = [...reader.allRows()].filter((r) => r.type === 'TEXT').flatMap((r) => { const n = reader.node(r.id); return n ? [n] : []; });
    const set = this.fonts.read(snapshotId, snapshot.snapshotHash);
    return { uses: fontUses(texts), ...(set ? { set } : {}), hosts: FONT_HOSTS };
  }

  /** Fetches the open fonts the snapshot's text uses. Called only when a person asked for it. */
  async fetchFonts(snapshotId: string, signal: AbortSignal): Promise<FontSet> {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) throw new HttpError(404, 'Snapshot không tồn tại.');
    const { uses } = this.fontsOf(snapshotId);
    if (!uses.length) throw new HttpError(409, 'Snapshot không có node chữ nào đọc được font.');
    return this.fontFetcher.fetchFor(snapshot, uses, signal);
  }

  /** Who still points at a snapshot: projects by default, and every run (finished or not) whose contract is bound to it. */
  referencesOf(snapshotId: string): { projects: string[]; runs: string[] } {
    return {
      projects: this.o.store.projects.list().filter((p) => p.designSource?.snapshotId === snapshotId).map((p) => p.name),
      runs: this.o.store.runs.list().filter((r) => r.contract.design?.snapshotId === snapshotId).map((r) => r.id),
    };
  }

  deleteSnapshot(id: string): void {
    if (!this.snapshots.get(id)) throw new HttpError(404, 'Snapshot không tồn tại.');
    const refs = this.referencesOf(id);
    if (refs.projects.length || refs.runs.length) throw new HttpError(409, `Snapshot còn được dùng: ${refs.projects.length ? `dự án ${refs.projects.slice(0, 3).join(', ')}` : ''}${refs.projects.length && refs.runs.length ? '; ' : ''}${refs.runs.length ? `${refs.runs.length} task (${refs.runs.slice(0, 3).join(', ')})` : ''}. Gỡ tham chiếu trước khi xóa.`);
    this.snapshots.remove(id);
  }

  bind(input: { snapshotId: string; targetIds?: string[] }): DesignBinding { return this.inputs.bind(input); }

  stagingRoot(): string { return path.join(this.o.dataDir, 'design-staging'); }
}
