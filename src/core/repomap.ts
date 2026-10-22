import { readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { RepoMap } from '../shared/types.js';
import { listTestFiles, readInside, SKIP_DIRS, testGlobs } from './stackdetect.js';

const MAX_ENTRIES = 5000;
const MAX_DEPTH = 3;
const ENTRY_DIRS = ['app', 'pages', 'src', 'lib', 'server', 'api', 'worker', 'workers', 'scripts', 'components', 'packages', 'cmd'];
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

interface Dir { rel: string; depth: number; files: number; total: number; children: Dir[] }

/**
 * A short orientation map of a repository: folders with file counts, scripts, entry points, test layout and which
 * agent docs exist. Names only, never file contents (package.json is parsed for script names and entry fields).
 * Read-only and bounded; symlinks and heavy folders (node_modules, .git, build output) are skipped.
 */
export async function buildRepoMap(repoDir: string): Promise<RepoMap> {
  const empty: RepoMap = { tree: '', scripts: '', entries: '', tests: '', docs: '', scriptNames: [], paths: [] };
  let root: string;
  try { root = await realpath(path.resolve(repoDir)); } catch { return empty; }
  const paths: string[] = [];
  let seen = 0;
  const walk = async (abs: string, rel: string, depth: number): Promise<Dir> => {
    const dir: Dir = { rel, depth, files: 0, total: 0, children: [] };
    let entries;
    try { entries = await readdir(abs, { withFileTypes: true }); } catch { return dir; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++seen > MAX_ENTRIES) break;
      if (e.isSymbolicLink()) continue;
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        paths.push(`${next}/`);
        const child = depth < MAX_DEPTH ? await walk(path.join(abs, e.name), next, depth + 1) : { rel: next, depth: depth + 1, files: 0, total: 0, children: [] };
        dir.children.push(child);
        dir.total += child.total;
      } else if (e.isFile()) {
        if (e.name.startsWith('.aidept-report.')) continue;
        paths.push(next);
        dir.files++; dir.total++;
      }
    }
    return dir;
  };
  const tree = await walk(root, '', 0);

  const lines: string[] = [];
  const render = (d: Dir) => {
    for (const c of d.children.filter((x) => x.total > 0)) {
      if (c.depth > 2) continue;
      lines.push(`${'  '.repeat(c.depth - 1)}- ${c.rel.split('/').pop()}/ (${c.total} file)`);
      render(c);
    }
  };
  render(tree);
  const rootFiles = paths.filter((p) => !p.includes('/')).slice(0, 25);

  let pkg: Record<string, unknown> = {};
  const pkgText = await readInside(root, 'package.json');
  if (pkgText) { try { pkg = asRecord(JSON.parse(pkgText)); } catch { /* not JSON: no scripts */ } }
  const scripts = Object.entries(asRecord(pkg.scripts)).filter(([, v]) => typeof v === 'string') as [string, string][];
  const entries = [
    ...['main', 'module', 'bin'].filter((k) => pkg[k] !== undefined).map((k) => `package.json ${k} = ${JSON.stringify(pkg[k]).slice(0, 80)}`),
    ...ENTRY_DIRS.filter((d) => paths.includes(`${d}/`)).map((d) => `${d}/`),
  ];
  const testFiles = await listTestFiles(root);
  const docs = ['AGENTS.md', 'CLAUDE.md', 'README.md', 'CONTRIBUTING.md'].filter((f) => paths.includes(f));

  return {
    tree: [...lines.slice(0, 60), ...(lines.length > 60 ? [`… (${lines.length - 60} thư mục nữa)`] : []), rootFiles.length ? `File ở gốc: ${rootFiles.join(', ')}` : ''].filter(Boolean).join('\n'),
    scripts: scripts.length ? scripts.slice(0, 20).map(([k, v]) => `- npm run ${k}: ${v.slice(0, 100)}`).join('\n') : 'Không có script trong package.json.',
    entries: entries.join(', '),
    tests: testFiles.length ? `${testFiles.length} file test; mẫu: ${testGlobs(testFiles).join(', ')}` : 'Chưa có file test nào (*.test.* / *.spec.*).',
    docs: docs.length ? `${docs.join(', ')}${docs.includes('AGENTS.md') ? ' (AGENTS.md: Codex tự đọc, không chép lại ở đây)' : ''}` : '',
    scriptNames: scripts.map(([k]) => k),
    paths: paths.slice(0, MAX_ENTRIES),
  };
}
