import path from 'node:path';
import type { DesignBinding, IntegrationSummary } from '../../shared/design.js';
import { HttpError } from '../run/support.js';
import type { Store } from '../store.js';
import { ExporterHub } from './exporter.js';
import { FigmaInstaller, type InstallerDeps } from './installer.js';
import { SnapshotStore } from './snapshots.js';
import { DesignInputs } from './designinput.js';

export interface FigmaServiceOptions {
  dataDir: string; store: Store; port: number;
  installerDeps?: InstallerDeps; now?: () => number; pollMs?: number;
}

/** Everything the Figma integration is made of, built once per server: the plugin hub, the installer, the snapshots and the task inputs. */
export class FigmaService {
  readonly snapshots: SnapshotStore;
  readonly hub: ExporterHub;
  readonly installer: FigmaInstaller;
  readonly inputs: DesignInputs;
  readonly origin: string;

  constructor(private readonly o: FigmaServiceOptions) {
    this.origin = `http://127.0.0.1:${o.port}`;
    this.snapshots = new SnapshotStore(o.dataDir, o.store);
    this.hub = new ExporterHub({ dataDir: o.dataDir, store: o.store, snapshots: this.snapshots, ...(o.now ? { now: o.now } : {}), ...(o.pollMs ? { pollMs: o.pollMs } : {}) });
    this.installer = new FigmaInstaller({ dataDir: o.dataDir, store: o.store, origin: this.origin, ...(o.installerDeps ? { deps: o.installerDeps } : {}) });
    this.inputs = new DesignInputs(o.dataDir, this.snapshots);
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
