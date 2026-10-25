import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Orchestrator } from '../src/server/orchestrator.js';
import { createRuntimeResolver } from '../src/server/environment.js';
import { Store } from '../src/server/store.js';
import type { RuntimeAttestation } from '../src/runtime/types.js';
import { DockerRuntime } from '../src/runtime/docker.js';
import { RuntimeBlockedError } from '../src/runtime/types.js';
import { profile } from './helpers.js';

/**
 * Real-Docker end-to-end. Needs a running daemon, the `aidept-runner-stub` image and the `aidept-agent`
 * network (see README). The agent is a scripted stub, so this proves runtime plumbing, not agent quality.
 *   AIDEPT_DOCKER_E2E=1 npx vitest run tests/docker.e2e.test.ts
 */
const enabled = process.env.AIDEPT_DOCKER_E2E === '1';
const sh = (cmd: string, args: string[], cwd?: string) => execFileSync(cmd, args, { cwd, encoding: 'utf8', shell: false }).trim();

function buggyRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidept-e2e-repo-'));
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', private: true, type: 'module', devDependencies: { vitest: '3.2.4' } }, null, 2));
  writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.aidept-report.json\n');
  // Off-by-one: n itself is never added.
  writeFileSync(path.join(dir, 'src', 'sum.ts'), 'export function sumTo(n: number): number {\n  let total = 0;\n  for (let i = 1; i < n; i++) total += i;\n  return total;\n}\n');
  // Host npm is npm.cmd on Windows; generating the lockfile in a container avoids depending on it.
  sh('docker', ['run', '--rm', '-v', `${dir}:/w`, '-w', '/w', '-e', 'HOME=/tmp', 'aidept-runner-stub', 'npm', 'install', '--package-lock-only', '--no-audit', '--no-fund']);
  sh('git', ['init', '-q'], dir);
  sh('git', ['add', '-A'], dir);
  sh('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], dir);
  return dir;
}

describe.skipIf(!enabled)('DockerRuntime end to end (real Docker)', () => {
  it('fixes a bugfix task inside containers with red/green evidence, leaving the source checkout untouched', async () => {
    const repo = buggyRepo();
    const headBefore = sh('git', ['rev-parse', 'HEAD'], repo);
    const dataDir = mkdtempSync(path.join(tmpdir(), 'aidept-e2e-data-'));
    const imageId = sh('docker', ['image', 'inspect', '--format', '{{.Id}}', 'aidept-runner-stub']);
    const attestation: RuntimeAttestation = {
      version: 1, projectId: 'prj_test', imageId, imageReference: 'aidept-runner-stub', approvedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(), network: 'aidept-agent',
      providerEgressVerified: true, nativeToolSurfaceVerified: true, singleAgentEnforcementVerified: true,
      providers: { codex: { version: 'stub', authVolume: 'aidept-e2e-auth' } },
    };
    mkdirSync(path.join(dataDir, 'attestations'));
    writeFileSync(path.join(dataDir, 'attestations', 'prj_test.json'), JSON.stringify(attestation));

    const store = new Store(':memory:');
    store.projects.put(profile({
      repository: repo, runnerImage: 'aidept-runner-stub', agentNetwork: 'aidept-agent', setupCommand: ['npm', 'ci', '--no-audit', '--no-fund'],
      checks: [{ id: 'test', command: ['npx', 'vitest', 'run', '--reporter=json', '--outputFile=.aidept-report.json'], required: true, timeoutMs: 120_000, reportPath: '.aidept-report.json' }],
    }));
    const orchestrator = new Orchestrator(store, createRuntimeResolver(dataDir));
    const run = orchestrator.createRun({ projectId: 'prj_test', title: 'Sửa sumTo', originalRequirement: 'sumTo(n) bỏ sót n.', mode: 'single', provider: 'codex', budgetUsd: 5, signals: [], taskKind: 'bugfix' });

    orchestrator.startRun(run.id); await orchestrator.idle();
    const planned = orchestrator.detail(run.id);
    expect(planned.run.status, planned.run.blocker ?? '').toBe('awaiting_approval');
    orchestrator.approveContract(run.id, { contractHash: orchestrator.detail(run.id).contractReview.contractHash, acknowledgeWarnings: true }); await orchestrator.idle();

    const detail = orchestrator.detail(run.id);
    const trace = detail.events.map((e) => `${e.type}: ${e.message}`).join('\n');
    expect(detail.run.status, `${detail.run.blocker}\n${trace}`).toBe('awaiting_acceptance');
    expect(detail.checks.at(-1)).toMatchObject({ status: 'passed', requirementIds: ['R-1'] });
    expect(detail.matrix[0]!.status).toBe('verified');
    const redGreen = detail.artifacts.find((a) => a.title.startsWith('Red/green'));
    expect(JSON.parse(redGreen!.content)).toMatchObject({ valid: true });
    expect(detail.artifacts.find((a) => a.kind === 'diff' && a.valid)!.content).toContain('i <= n');
    expect(detail.artifacts.some((a) => a.kind === 'acceptance')).toBe(true);

    // The agent worked on a clone: the original checkout is byte-for-byte where it started.
    expect(sh('git', ['rev-parse', 'HEAD'], repo)).toBe(headBefore);
    expect(sh('git', ['status', '--porcelain'], repo)).toBe('');
    const branchTip = sh('git', ['rev-parse', `aidept/${run.id}-A`], path.join(dataDir, 'workspaces', `${run.id}-A`));
    expect(branchTip).toBe(detail.run.checkpoint);
    await orchestrator.acceptRun(run.id);
    expect(sh('git', ['rev-parse', `refs/heads/aidept/${run.id}-A`], repo)).toBe(detail.run.checkpoint);
    expect(sh('git', ['status', '--porcelain'], repo)).toBe('');
  }, 600_000);

  function liveSetup(overrides: Partial<RuntimeAttestation> = {}, checkCommand: string[] = ['true']) {
    const repo = buggyRepo();
    const dataDir = mkdtempSync(path.join(tmpdir(), 'aidept-e2e-data-'));
    const imageId = sh('docker', ['image', 'inspect', '--format', '{{.Id}}', 'aidept-runner-stub']);
    const attestation: RuntimeAttestation = {
      version: 1, projectId: 'prj_test', imageId, imageReference: 'aidept-runner-stub', approvedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(), network: 'aidept-agent',
      providerEgressVerified: true, nativeToolSurfaceVerified: true, singleAgentEnforcementVerified: true,
      providers: { codex: { version: 'stub', authVolume: 'aidept-e2e-auth' } }, ...overrides,
    };
    const store = new Store(':memory:');
    store.projects.put(profile({ repository: repo, runnerImage: 'aidept-runner-stub', agentNetwork: 'aidept-agent', checks: [{ id: 'probe', command: checkCommand, required: true, timeoutMs: 60_000 }] }));
    const orchestrator = new Orchestrator(store, () => { throw new Error('unused'); });
    const run = orchestrator.createRun({ projectId: 'prj_test', title: 't', originalRequirement: 'r', mode: 'single', provider: 'codex', budgetUsd: 5, signals: [] });
    return { run, runtime: new DockerRuntime({ dataDir, attestation }) };
  }

  it('check containers are offline, read-only at the root, and see no host paths or Docker socket', async () => {
    const probe = `
      const net = require('net'), fs = require('fs'); const out = {};
      const tryWrite = (p) => { try { fs.writeFileSync(p, 'x'); return true; } catch { return false; } };
      out.rootWritable = tryWrite('/etc/probe'); out.workspaceWritable = tryWrite('/workspace/probe.txt');
      out.hostPaths = ['/Users', '/c', '/mnt/c', '/host_mnt'].filter((p) => fs.existsSync(p));
      out.dockerSock = fs.existsSync('/var/run/docker.sock'); out.uid = process.getuid();
      const s = net.connect({ host: '1.1.1.1', port: 53, timeout: 3000 });
      s.on('connect', () => { out.network = true; console.log(JSON.stringify(out)); process.exit(0); });
      s.on('error', () => { out.network = false; console.log(JSON.stringify(out)); process.exit(0); });
      s.on('timeout', () => { out.network = false; console.log(JSON.stringify(out)); process.exit(0); });`;
    const { run, runtime } = liveSetup({}, ['node', '-e', probe]);
    await runtime.prepare(run, 'A');
    const result = await runtime.runCheck({ run, recipe: run.configSnapshot.checks[0]!, slot: 'A', ref: 'candidate' });
    expect(result.exitCode, result.log).toBe(0);
    expect(JSON.parse(result.log.trim().split('\n')[0]!)).toEqual({ rootWritable: false, workspaceWritable: true, hostPaths: [], dockerSock: false, uid: 1000, network: false });
  }, 180_000);

  it('refuses to run when the image differs from the attested one, or the attestation is expired or unverified', async () => {
    const wrongImage = liveSetup({ imageId: 'sha256:' + '0'.repeat(64) });
    await expect(wrongImage.runtime.prepare(wrongImage.run, 'A')).rejects.toBeInstanceOf(RuntimeBlockedError);
    const expired = liveSetup({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    await expect(expired.runtime.prepare(expired.run, 'A')).rejects.toThrow(/hết hạn/);
    const unverified = liveSetup({ providerEgressVerified: false });
    await expect(unverified.runtime.prepare(unverified.run, 'A')).rejects.toThrow(/chưa được kiểm chứng/);
  }, 120_000);

  it('a timed-out check is incomplete, never a pass', async () => {
    const { run, runtime } = liveSetup({}, ['sleep', '30']);
    await runtime.prepare(run, 'A');
    const result = await runtime.runCheck({ run, recipe: { ...run.configSnapshot.checks[0]!, timeoutMs: 1500 }, slot: 'A', ref: 'candidate' });
    expect(result.incomplete).toBe(true);
    // The timed-out container must not linger.
    expect(sh('docker', ['ps', '-q', '--filter', `name=check-${run.id}`])).toBe('');
  }, 120_000);
});
