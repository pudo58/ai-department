import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Health, Run } from '../shared/types.js';
import { FakeRuntime } from '../runtime/fake.js';
import { DockerRuntime } from '../runtime/docker.js';
import { LocalRuntime } from '../runtime/local.js';
import { resolveCodexCommand } from '../runtime/hostcommand.js';
import { executeFile } from '../runtime/process.js';
import { RuntimeBlockedError, type Runtime, type RuntimeAttestation } from '../runtime/types.js';
import { diskSpace } from './storage.js';
import { cachedCliStatus } from '../runtime/agentclis.js';

const AttestationSchema = z.object({
  version: z.literal(1), projectId: z.string(), imageId: z.string(), imageReference: z.string(),
  approvedAt: z.string(), expiresAt: z.string(), network: z.string(),
  providerEgressVerified: z.boolean(), nativeToolSurfaceVerified: z.boolean(), singleAgentEnforcementVerified: z.boolean(),
  providers: z.object({
    codex: z.object({ version: z.string(), authVolume: z.string() }).optional(),
    claude: z.object({ version: z.string(), authVolume: z.string() }).optional(),
  }),
});

export function loadAttestation(dataDir: string, projectId: string): RuntimeAttestation | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) return undefined;
  const file = path.join(dataDir, 'attestations', `${projectId}.json`);
  if (!existsSync(file)) return undefined;
  const parsed = AttestationSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  return parsed.success ? parsed.data : undefined;
}

/** Fake runs share one simulator; every live run needs an operator attestation for its project. */
export function createRuntimeResolver(dataDir: string, fake: Runtime = new FakeRuntime()): (run: Run) => Runtime {
  let local: LocalRuntime | undefined;
  return (run) => {
    if (run.provider === 'fake') return fake;
    if (run.configSnapshot.executionMode === 'local') return (local ??= new LocalRuntime({ dataDir }));
    const attestation = loadAttestation(dataDir, run.projectId);
    if (!attestation) throw new RuntimeBlockedError('Project đang chạy ở chế độ Docker nhưng chưa có attestation runtime nên chạy thật bị chặn. Sửa project và chọn "Local (trên máy này)" ở mục "Nơi chạy agent và check", duyệt lại policy rồi bấm Chạy tiếp.');
    return new DockerRuntime({ dataDir, attestation });
  };
}

const HEALTH_TTL_MS = 20_000;
const healthCache = new Map<string, { at: number; value: Promise<Health> }>();

/** Probing Docker and Codex spawns processes, so the answer is shared for a few seconds across callers. */
export function checkHealth(dataDir: string): Promise<Health> {
  const cached = healthCache.get(dataDir);
  if (cached && Date.now() - cached.at < HEALTH_TTL_MS) return cached.value;
  const value = computeHealth(dataDir);
  healthCache.set(dataDir, { at: Date.now(), value });
  return value;
}

async function computeHealth(dataDir: string): Promise<Health> {
  // Both probes can be slow; run them side by side.
  const codexProbe = localCodexReady();
  const versionProbe = codexVersion();
  const diskProbe = diskSpace(dataDir);
  const claudeProbe = cachedCliStatus('claude').catch(() => undefined);
  const limitations = [
    'Công cụ phân tích code (knip, jscpd, dependency-cruiser) chưa được cấu hình: báo "chưa phân tích".',
    'Task kiểu feature chưa tự động hóa phase base+stub; chỉ bugfix và refactor có kiểm tra red/green.',
  ];
  let docker = false, dockerMessage = '';
  try {
    const result = await executeFile('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 5000 });
    docker = result.exitCode === 0;
    dockerMessage = docker ? `Docker ${result.stdout.trim()}` : (result.stderr.split('\n')[0] ?? 'Docker không phản hồi.').slice(0, 200);
  } catch (error) { dockerMessage = (error as Error).message; }
  if (!docker) limitations.push('Docker không sẵn sàng: chỉ chạy được chế độ mô phỏng.');
  const attestations = existsSync(path.join(dataDir, 'attestations'));
  if (!attestations) limitations.push('Chưa có attestation runtime nào: chạy thật bị chặn cho đến khi operator xác nhận.');
  const usable = (name: 'codex' | 'claude') => {
    if (!attestations) return false;
    try {
      const dir = path.join(dataDir, 'attestations');
      return readdirSync(dir).some((f) => {
        const a = loadAttestation(dataDir, f.replace(/\.json$/, ''));
        return !!a?.providers[name] && Date.parse(a.expiresAt) > Date.now();
      });
    } catch { return false; }
  };
  const codex = usable('codex'), claude = usable('claude');
  const localCodex = await codexProbe;
  if (!localCodex) limitations.push('Chế độ local: Codex CLI chưa cài hoặc chưa đăng nhập. Xem trang Kết nối AI.');
  const [version, disk, claudeCli] = await Promise.all([versionProbe, diskProbe, claudeProbe]);
  const localClaude = !!claudeCli?.installed && !!claudeCli.loggedIn;
  if (disk && disk.level !== 'ok') limitations.push(`Ổ ${disk.path} chỉ còn ${(disk.freeBytes / 1024 ** 3).toFixed(1)} GB trống: npm, test và Codex có thể lỗi khi hết chỗ.`);
  return { node: process.version, docker, dockerMessage, codex, claude, localCodex, fake: true, liveReady: (docker && (codex || claude)) || localCodex || localClaude, localClaude, limitations, ...(version ? { codexVersion: version } : {}), ...(disk ? { disk } : {}) };
}

/** True when a Codex CLI can be located and reports a login. This reads status only, never credentials. */
async function codexVersion(): Promise<string | undefined> {
  try {
    const [exe, ...args] = resolveCodexCommand();
    const result = await executeFile(exe!, [...args, '--version'], { timeoutMs: 10_000 });
    return result.exitCode === 0 ? result.stdout.trim().split('\n')[0]?.slice(0, 80) : undefined;
  } catch { return undefined; }
}

async function localCodexReady(): Promise<boolean> {
  try {
    const [exe, ...args] = resolveCodexCommand();
    const result = await executeFile(exe!, [...args, 'login', 'status'], { timeoutMs: 10_000 });
    return result.exitCode === 0 && /logged in/i.test(`${result.stdout}${result.stderr}`);
  } catch { return false; }
}
