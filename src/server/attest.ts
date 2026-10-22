import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { executeFile } from '../runtime/process.js';
import type { RuntimeAttestation } from '../runtime/types.js';

/**
 * Writes the operator attestation that unlocks live runs for one project.
 * The three *Verified flags are claims YOU make; they default to false and the tool cannot check them.
 *
 *   npm run attest -- --project prj_xxxx --image aidept-runner --codex-volume aidept-codex-auth \
 *     --egress-verified --tool-surface-verified --single-agent-verified
 */
const args = process.argv.slice(2);
const value = (name: string): string | undefined => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const flag = (name: string) => args.includes(`--${name}`);
const fail = (message: string): never => { console.error(message); process.exit(1); };

const projectId = value('project') ?? fail('Cần --project <id>.');
const image = value('image') ?? 'aidept-runner';
const days = Number(value('days') ?? 30);
const codexVolume = value('codex-volume'), claudeVolume = value('claude-volume');
if (!codexVolume && !claudeVolume) fail('Cần ít nhất --codex-volume hoặc --claude-volume (volume chứa phiên đăng nhập).');
if (!/^[A-Za-z0-9_-]+$/.test(projectId)) fail('Project id không hợp lệ.');

const inspect = await executeFile('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { timeoutMs: 30_000 });
if (inspect.exitCode !== 0) fail(`Không tìm thấy image "${image}": ${inspect.stderr.trim()}`);
const version = async (cmd: string) => (await executeFile('docker', ['run', '--rm', image, cmd, '--version'], { timeoutMs: 60_000 })).stdout.trim() || 'unknown';

const now = new Date();
const attestation: RuntimeAttestation = {
  version: 1, projectId, imageId: inspect.stdout.trim(), imageReference: image,
  approvedAt: now.toISOString(), expiresAt: new Date(now.getTime() + days * 86_400_000).toISOString(),
  network: value('network') ?? 'aidept-agent',
  providerEgressVerified: flag('egress-verified'), nativeToolSurfaceVerified: flag('tool-surface-verified'),
  singleAgentEnforcementVerified: flag('single-agent-verified'),
  providers: {
    ...(codexVolume ? { codex: { version: await version('codex'), authVolume: codexVolume } } : {}),
    ...(claudeVolume ? { claude: { version: await version('claude'), authVolume: claudeVolume } } : {}),
  },
};
const dir = path.join(path.resolve(process.env.AIDEPT_DATA_DIR ?? '.data'), 'attestations');
mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${projectId}.json`);
writeFileSync(file, JSON.stringify(attestation, null, 2));
console.log(`Đã ghi ${file}`);
const unverified = (['providerEgressVerified', 'nativeToolSurfaceVerified', 'singleAgentEnforcementVerified'] as const).filter((k) => !attestation[k]);
if (unverified.length) console.log(`Cảnh báo: chưa xác nhận ${unverified.join(', ')}; chạy thật sẽ bị chặn cho đến khi bạn tự kiểm chứng và bật cờ tương ứng.`);
