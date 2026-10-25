import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { readInside, SKIP_DIRS } from '../core/stackdetect.js';
import { isSafeRelative } from '../core/scope.js';
import type { MutationCapability } from '../shared/quality.js';

export const STRYKER_VERSION = '9.6.1';
const install = `Cài trong project: npm install --save-dev --save-exact @stryker-mutator/core@${STRYKER_VERSION} @stryker-mutator/vitest-runner@${STRYKER_VERSION} (Vitest >=2, Node >=20). Sau đó commit manifest và lockfile rồi tạo run mới.`;

/** Reads package metadata only. Never imports a repository's executable config or runs its scripts. */
export async function detectMutation(repository: string, selected?: string): Promise<MutationCapability> {
  const root = await realpath(repository).catch(() => '');
  if (!root) return { status: 'unsupported', reason: 'Không đọc được project để nhận diện mutation.' };
  const roots: string[] = [];
  const scan = async (rel: string, depth: number): Promise<void> => {
    if (roots.length >= 30) return;
    if (await readInside(root, path.posix.join(rel, 'package.json'))) roots.push(rel || '.');
    if (depth === 2) return;
    for (const e of await readdir(path.join(root, rel), { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name) && !['vendor', 'target'].includes(e.name)) await scan(path.posix.join(rel, e.name), depth + 1);
    }
  };
  await scan('', 0);
  const candidates: { root: string; pkg: Record<string, unknown> }[] = [];
  for (const rel of roots) {
    try {
      const pkg = JSON.parse((await readInside(root, path.posix.join(rel, 'package.json')))!) as Record<string, unknown>;
      const deps = { ...pkg.dependencies as object, ...pkg.devDependencies as object } as Record<string, unknown>;
      if ('vitest' in deps) candidates.push({ root: rel, pkg });
    } catch { /* invalid manifest is not executable evidence */ }
  }
  if (selected && selected !== '.' && !isSafeRelative(selected)) return { status: 'ambiguous', reason: 'Thư mục mutation phải nằm trong project.', candidates: candidates.map(c => c.root) };
  if (!selected && candidates.length > 1) return { status: 'ambiguous', reason: 'Có nhiều package Vitest; chọn thư mục mutation trong cấu hình project.', candidates: candidates.map(c => c.root) };
  const found = selected ? candidates.find(c => c.root === selected.replace(/\\/g, '/').replace(/\/$/, '')) : candidates[0];
  if (!found) return { status: 'unsupported', reason: selected ? 'Package đã chọn không có Vitest được khai báo.' : 'Mutation chưa hỗ trợ cho stack này (adapter đầu tiên: JS/TS + Vitest).' };
  const rootFiles = await readdir(root);
  const guide = rootFiles.includes('pnpm-lock.yaml') ? install.replace('npm install --save-dev --save-exact', 'pnpm add -D --save-exact') : rootFiles.includes('yarn.lock') ? install.replace('npm install --save-dev --save-exact', 'yarn add -D --exact') : rootFiles.some(f => f === 'bun.lock' || f === 'bun.lockb') ? install.replace('npm install --save-dev --save-exact', 'bun add -d --exact') : install;
  const base = { adapter: 'stryker-vitest' as const, root: found.root, candidates: candidates.map(c => c.root), install: guide };
  try {
    const packageRoot = path.resolve(root, found.root);
    // Resolve only installed packages, including hoisted workspace dependencies.
    const metadata = async (name: string): Promise<{ version: string }> => {
      let at = packageRoot;
      for (;;) {
        try { return JSON.parse(await readFile(path.join(at, 'node_modules', name, 'package.json'), 'utf8')); } catch { /* Try only hoists inside this repository. */ }
        if (at === root) throw new Error('Tool is not installed in this project');
        const parent = path.dirname(at);
        if (parent === at || (parent !== root && !parent.startsWith(root + path.sep))) throw new Error('Tool is outside project');
        at = parent;
      }
    };
    const [core, runner, vitest] = await Promise.all([metadata('@stryker-mutator/core'), metadata('@stryker-mutator/vitest-runner'), metadata('vitest')]);
    // This adapter is tested against this exact tool pair. Other pairs must not be guessed compatible.
    if (core.version !== STRYKER_VERSION || runner.version !== STRYKER_VERSION || Number(vitest.version.split('.')[0]) < 2) return { ...base, status: 'missing_tool', reason: `Phiên bản chưa tương thích với adapter: Stryker ${core.version}/${runner.version}, Vitest ${vitest.version}.`, toolVersion: core.version, vitestVersion: vitest.version };
    const files = await readdir(path.join(root, found.root));
    const configs = files.filter(f => /^vitest\.config\.[cm]?[jt]s$/.test(f) || /^vite\.config\.[cm]?[jt]s$/.test(f));
    const vitestConfigs = configs.filter(f => f.startsWith('vitest.'));
    if (vitestConfigs.length > 1 || (!vitestConfigs.length && configs.length > 1)) return { ...base, status: 'ambiguous', reason: 'Có nhiều cấu hình test trong package đã chọn; hãy giữ một cấu hình Vitest chính.' };
    return { ...base, status: 'available', reason: 'Đã nhận diện JS/TS + Vitest và bộ Stryker tương thích.', toolVersion: core.version, vitestVersion: vitest.version, configFile: vitestConfigs[0] ?? configs[0] };
  } catch { return { ...base, status: 'missing_tool', reason: 'Thiếu bộ Stryker/Vitest đã cài trong project; hệ thống không tự cài dependency.' }; }
}
