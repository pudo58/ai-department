import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_NODE_VERSION, APP_NPM_VERSION, Toolchains } from '../src/runtime/toolchain.js';
import { executeFile } from '../src/runtime/process.js';

const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot!, 'System32/tar.exe') : 'tar';
const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '', timedOut: false, durationMs: 1 });
function fixture(platform: NodeJS.Platform = 'win32') {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidept-node-dist-'));
  const top = path.join(dir, 'dist');
  const npm = path.join(top, platform === 'win32' ? 'node_modules/npm' : 'lib/node_modules/npm');
  const node = path.join(top, platform === 'win32' ? 'node.exe' : 'bin/node');
  mkdirSync(path.dirname(node), { recursive: true }); mkdirSync(path.join(npm, 'bin'), { recursive: true });
  writeFileSync(node, 'node'); writeFileSync(path.join(npm, 'bin/npm-cli.js'), 'npm'); writeFileSync(path.join(npm, 'bin/npx-cli.js'), 'npx'); writeFileSync(path.join(npm, 'package.json'), JSON.stringify({ version: APP_NPM_VERSION }));
  const archivePath = path.join(dir, 'archive.tar.gz');
  expect(spawnSync(tar, ['-czf', archivePath, '-C', dir, 'dist']).status).toBe(0);
  const archive = readFileSync(archivePath), digest = createHash('sha256').update(archive).digest('hex');
  const name = `node-v${APP_NODE_VERSION}-${platform === 'win32' ? 'win' : platform}-x64.${platform === 'win32' ? 'zip' : 'tar.gz'}`;
  const state = { downloads: 0, tamper: false, brokenNpm: false, npmVersion: APP_NPM_VERSION, requests: [] as string[] };
  const tools = new Toolchains({ dataDir: path.join(dir, 'home/runtime'), platform, arch: 'x64', fetchImpl: (async (url: string) => {
    state.requests.push(String(url));
    if (String(url).endsWith('SHASUMS256.txt')) return new Response(`${state.tamper ? '0'.repeat(64) : digest}  ${name}\n`);
    state.downloads++; return new Response(new Uint8Array(archive));
  }) as typeof fetch, run: async (_exe, args) => {
    if (args[0] === '--version') return ok(`v${APP_NODE_VERSION}\n`);
    if (args[1] === '--version') return state.brokenNpm ? { ...ok(), exitCode: 1 } : ok(`${state.npmVersion}\n`);
    return executeFile(tar, args);
  } });
  const cleanup = () => {
    if (path.dirname(dir) !== path.resolve(tmpdir()) || !path.basename(dir).startsWith('aidept-node-dist-')) throw new Error('Unexpected fixture directory');
    rmSync(dir, { recursive: true, force: true });
  };
  return { tools, state, cleanup };
}

describe('a complete, pinned application runtime', () => {
  it.each(['win32', 'linux', 'darwin'] as const)('downloads the official Node + npm pair on %s, verifies it and reuses it offline', async platform => {
    const f = fixture(platform);
    try {
      const [home, same] = await Promise.all([f.tools.ensureNode(), f.tools.ensureNode()]);
      expect(home).toBe(same); expect(f.state.downloads).toBe(1);
      expect(f.state.requests.every(url => url.startsWith(`https://nodejs.org/dist/v${APP_NODE_VERSION}/`))).toBe(true);
      f.state.requests = [];
      expect(await f.tools.ensureNode()).toBe(home); expect(f.state.requests).toEqual([]);
      const npm = path.join(home, platform === 'win32' ? 'node_modules/npm' : 'lib/node_modules/npm');
      rmSync(path.join(npm, 'bin/npm-cli.js'));
      await f.tools.ensureNode(); expect(f.state.downloads).toBe(2); // repair an old/partial runtime, without old npm
    } finally { f.cleanup(); }
  });
  it('refuses tampered archives before extraction and leaves no usable runtime', async () => {
    const f = fixture(); f.state.tamper = true;
    try {
      await expect(f.tools.ensureNode()).rejects.toThrow(/không khớp/);
      expect(existsSync(path.join(f.tools.root, `node-${APP_NODE_VERSION}`))).toBe(false);
    } finally { f.cleanup(); }
  });
  it('does not mark a runtime ready when npm cannot run, and retries successfully next launch', async () => {
    const f = fixture(); f.state.brokenNpm = true;
    try {
      await expect(f.tools.ensureNode()).rejects.toThrow(/không chạy đúng phiên bản/);
      expect(existsSync(path.join(f.tools.root, `node-${APP_NODE_VERSION}`, '.aidept-installed'))).toBe(false);
      f.state.brokenNpm = false; await f.tools.ensureNode(); expect(f.state.downloads).toBe(2);
    } finally { f.cleanup(); }
  });
  it('rejects an executable but wrong npm version instead of silently accepting the old resolver', async () => {
    const f = fixture(); f.state.npmVersion = '10.9.9';
    try {
      await expect(f.tools.ensureNode()).rejects.toThrow(/không chạy đúng phiên bản/);
      f.state.npmVersion = APP_NPM_VERSION; await f.tools.ensureNode(); expect(f.state.downloads).toBe(2);
    } finally { f.cleanup(); }
  });
});
