import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { GUIDANCE_MAX_CHARS } from '../shared/guidance.js';
import type { StackDetection, SuggestedCheck } from '../shared/types.js';
import { nodeTestProblem, type NodeVersion } from './nodever.js';
import { detectOtherStacks, nestedProjects } from './stackother.js';
import { planNpmSetup } from './npmsetup.js';

/**
 * Read-only stack detection for a repository. It only reads a handful of well-known manifest and config files
 * inside the repository root, never executes anything and never evaluates a config file (JS configs count by name).
 * Everything it returns is a suggestion that a person confirms.
 */

const MAX_FILE_BYTES = 256 * 1024;
export const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.data', '.turbo', 'out']);
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const NO_TEST_SCRIPT = /no test specified/i;

/**
 * `node --test <flags> <files>` written as an npm script, restated with the JUnit report a check needs and nothing else changed.
 * Only a plain command is restated: a script with shell operators, variables, quotes or a reporter of its own is left to the caller.
 */
function nodeTestFromScript(script: string): string[] | undefined {
  if (/[&|;<>`$()"']|--test-reporter/.test(script)) return undefined;
  const tokens = script.trim().split(/\s+/);
  if (tokens[0] !== 'node' || !tokens.includes('--test')) return undefined;
  const rest = tokens.slice(1);
  rest.splice(rest.indexOf('--test'), 1);
  return ['node', '--test', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=junit', '--test-reporter-destination=.aidept-report.xml', ...rest];
}

/** Reads one file strictly inside `root`: no `..`, no symlink that resolves outside, bounded size. */
export async function readInside(root: string, rel: string): Promise<string | undefined> {
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) return undefined;
  try {
    const info = await lstat(full);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return undefined;
    const real = await realpath(full);
    if (!real.startsWith(root + path.sep)) return undefined;
    return await readFile(real, 'utf8');
  } catch { return undefined; }
}

async function listRoot(root: string): Promise<Set<string>> {
  try { return new Set(await readdir(root)); } catch { return new Set(); }
}

/** Lists test files (posix paths) in the repo, bounded in depth and entries so a huge repo cannot stall it. */
export async function listTestFiles(root: string): Promise<string[]> {
  let seen = 0;
  const found: string[] = [];
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > 4 || seen > 3000) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++seen > 3000) return;
      if (e.isSymbolicLink()) continue;
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(path.join(dir, e.name), next, depth + 1); }
      else if (TEST_FILE.test(e.name)) found.push(next);
    }
  };
  await walk(root, '', 0);
  return found;
}

/**
 * One glob per (folder, suffix) actually present, for example tests/ plus a .test.cjs suffix. node --test expands globs
 * itself (no shell), so the patterns must match the real extension: a hardcoded .test.ts glob silently finds nothing
 * in a .cjs repo.
 */
export function testGlobs(files: readonly string[], limit = 6): string[] {
  const globs = new Set<string>();
  for (const f of files) {
    const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/') + 1) : '';
    const suffix = /\.((?:test|spec)\.[cm]?[jt]sx?)$/.exec(f)![1]!;
    globs.add(`${dir}*.${suffix}`);
  }
  return [...globs].sort().slice(0, limit);
}

/** tsconfig is JSON with comments and trailing commas; strip them outside of strings, then parse best-effort. */
export function parseLooseJson(text: string): Record<string, unknown> | undefined {
  let out = '', inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) { out += c; if (c === '\\') out += text[++i] ?? ''; else if (c === '"') inString = false; continue; }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  try { const value: unknown = JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; } catch { return undefined; }
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const hasConfig = (files: Set<string>, stem: string): boolean => [...files].some((f) => f === stem || f.startsWith(`${stem}.`));

const LOCKFILES: [string, NonNullable<StackDetection['packageManager']>][] = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun'], ['bun.lock', 'bun'], ['npm-shrinkwrap.json', 'npm'], ['package-lock.json', 'npm']];

/** `nodeVersion` is the `node` on PATH, which runs "node --test" checks; leave it out when unknown. */
export async function detectStack(repoDir: string, nodeVersion?: NodeVersion): Promise<StackDetection> {
  let root: string;
  try { root = await realpath(path.resolve(repoDir)); } catch { return { packageManager: null, languages: [], frameworks: [], testRunner: null, linters: [], guidance: '', checks: [], setupCommand: [], notes: ['Không đọc được thư mục repository.'] }; }
  const files = await listRoot(root);
  const notes: string[] = [];
  const pkgText = await readInside(root, 'package.json');
  let pkg: Record<string, unknown> | undefined;
  if (pkgText !== undefined) { try { pkg = asRecord(JSON.parse(pkgText)); } catch { notes.push('package.json không phải JSON hợp lệ.'); } }

  const packageManager = LOCKFILES.find(([f]) => files.has(f))?.[1]
    ?? (/^(pnpm|yarn|bun|npm)@/.exec(String(pkg?.packageManager ?? ''))?.[1] as StackDetection['packageManager'] | undefined)
    ?? (pkg ? 'npm' : null);
  const scripts = asRecord(pkg?.scripts);
  const deps = { ...asRecord(pkg?.dependencies), ...asRecord(pkg?.devDependencies) };
  const has = (name: string) => name in deps;
  const script = (name: string) => (typeof scripts[name] === 'string' ? scripts[name] as string : undefined);

  const languages: string[] = [];
  const tsconfigText = await readInside(root, 'tsconfig.json');
  const tsconfig = tsconfigText !== undefined ? parseLooseJson(tsconfigText) : undefined;
  const compilerOptions = asRecord(tsconfig?.compilerOptions);
  if (tsconfigText !== undefined || has('typescript')) languages.push(compilerOptions.strict === true ? 'TypeScript (strict)' : 'TypeScript');
  if (pkg) languages.push('JavaScript');

  const frameworks: string[] = [];
  const framework = (label: string, ...signals: string[]) => { if (signals.some((s) => has(s) || hasConfig(files, s))) frameworks.push(label); };
  framework('Next.js', 'next', 'next.config'); framework('Nuxt', 'nuxt', 'nuxt.config'); framework('Astro', 'astro', 'astro.config');
  framework('SvelteKit', '@sveltejs/kit', 'svelte.config'); framework('Angular', '@angular/core', 'angular.json'); framework('Remix', '@remix-run/react');
  framework('React', 'react'); framework('Vue', 'vue'); framework('Svelte', 'svelte');
  framework('Vite', 'vite', 'vite.config'); framework('Webpack', 'webpack.config');
  framework('Fastify', 'fastify'); framework('Express', 'express'); framework('NestJS', '@nestjs/core'); framework('Hono', 'hono'); framework('Koa', 'koa');
  framework('Tailwind CSS', 'tailwindcss', 'tailwind.config'); framework('Prisma', '@prisma/client', 'prisma'); framework('Drizzle', 'drizzle-orm'); framework('Zod', 'zod');

  let testRunner: string | null = null;
  if (has('vitest') || hasConfig(files, 'vitest.config')) testRunner = 'Vitest';
  else if (has('jest') || hasConfig(files, 'jest.config')) testRunner = 'Jest';
  else if (has('@playwright/test') || hasConfig(files, 'playwright.config')) testRunner = 'Playwright';
  else if (has('mocha')) testRunner = 'Mocha';
  const e2e = has('@playwright/test') || hasConfig(files, 'playwright.config') ? 'Playwright' : has('cypress') ? 'Cypress' : null;

  const linters: string[] = [];
  if (has('eslint') || [...files].some((f) => f.startsWith('.eslintrc') || f.startsWith('eslint.config'))) linters.push('ESLint');
  if (has('@biomejs/biome') || files.has('biome.json') || files.has('biome.jsonc')) linters.push('Biome');
  if (has('prettier') || [...files].some((f) => f.startsWith('.prettierrc') || f.startsWith('prettier.config'))) linters.push('Prettier');

  // Java/Kotlin, Python, Go and Rust: same output shape as the Node part, merged in below.
  const others = await detectOtherStacks({ files, read: (rel) => readInside(root, rel), root });
  languages.push(...others.flatMap((o) => o.languages));
  frameworks.push(...others.flatMap((o) => o.frameworks));
  const nodeRunner = testRunner;
  testRunner ??= others.find((o) => o.testRunner)?.testRunner ?? null;
  notes.push(...others.flatMap((o) => o.notes));
  if (!pkg && !others.length) {
    const nested = await nestedProjects(root);
    notes.push(nested.length
      ? `Không thấy package.json hay manifest ở thư mục gốc, nhưng có trong: ${nested.join(', ')}. Chọn thư mục đó làm thư mục project (hoặc nhập check thủ công).`
      : 'Không thấy manifest quen thuộc (package.json, pom.xml, build.gradle, pyproject.toml, go.mod, Cargo.toml): nhập hướng dẫn và check thủ công.');
  }

  const checks: SuggestedCheck[] = [];
  const testFiles = await listTestFiles(root);
  const testScript = script('test');
  if (testScript !== undefined && !NO_TEST_SCRIPT.test(testScript)) {
    if (testRunner === 'Vitest') checks.push({ id: 'test', label: 'Vitest', command: ['npm', 'test', '--', '--run', '--reporter=json', '--outputFile=.aidept-report.json'], reportPath: '.aidept-report.json', required: true, timeoutMs: 600_000, recommended: true, reason: `Script "test" chạy Vitest (${testScript}).` });
    else if (testRunner === 'Jest') checks.push({ id: 'test', label: 'Jest', command: ['npx', 'jest', '--json', '--outputFile=.aidept-report.json'], reportPath: '.aidept-report.json', required: true, timeoutMs: 600_000, recommended: true, reason: `Script "test" chạy Jest (${testScript}).` });
    else {
      // The script runs Node's own test runner: the same command, flags and files, with the report Verify reads to tie each test to a requirement.
      const node = nodeTestFromScript(testScript), problem = node ? nodeTestProblem(node, nodeVersion) : undefined;
      if (node && !problem) checks.push({ id: 'test', label: 'node --test', command: node, reportPath: '.aidept-report.xml', required: true, timeoutMs: 600_000, recommended: true, reason: `Script "test" chạy node --test (${testScript.slice(0, 80)}); thêm report JUnit để mỗi test gắn được với yêu cầu [R-x]. Cờ và file test của script được giữ nguyên.` });
      else {
        if (problem) notes.push(`Không gợi ý "node --test" có report: ${problem}`);
        checks.push({ id: 'test', label: 'npm test', command: ['npm', 'test'], required: true, timeoutMs: 600_000, recommended: true, reason: `Script "test" là "${testScript.slice(0, 80)}" nhưng runner không có report đọc được: check chỉ dựa trên exit code, không tạo bằng chứng theo yêu cầu [R-x].` });
      }
    }
  } else if (testFiles.length > 0 && testRunner === 'Vitest') {
    checks.push({ id: 'test', label: 'Vitest', command: ['npx', 'vitest', 'run', '--reporter=json', '--outputFile=.aidept-report.json'], reportPath: '.aidept-report.json', required: true, timeoutMs: 600_000, recommended: true, reason: `Có ${testFiles.length} file test và Vitest nhưng chưa có script "test".` });
  } else if (testFiles.length > 0 && testRunner === 'Jest') {
    checks.push({ id: 'test', label: 'Jest', command: ['npx', 'jest', '--json', '--outputFile=.aidept-report.json'], reportPath: '.aidept-report.json', required: true, timeoutMs: 600_000, recommended: true, reason: `Có ${testFiles.length} file test và Jest nhưng chưa có script "test".` });
  } else if (testFiles.length > 0) {
    const command = ['node', '--test', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=junit', '--test-reporter-destination=.aidept-report.xml', ...testGlobs(testFiles)];
    // node --test is only a suggestion when this machine's Node can run it; otherwise say why it is off instead of suggesting a check that cannot work.
    const problem = nodeTestProblem(command, nodeVersion);
    if (problem) notes.push(`Không gợi ý "node --test": ${problem}`);
    checks.push({ id: 'test', label: 'node --test', command, reportPath: '.aidept-report.xml', required: true, timeoutMs: 600_000, recommended: !problem, reason: problem ?? `Có ${testFiles.length} file test (${testGlobs(testFiles).join(', ')}) nhưng chưa có script "test"; node --test không cần cài thêm gì.` });
  } else if (pkg) notes.push('Chưa thấy test nào. Không có check kiểm chứng hành vi thì yêu cầu không thể được xác minh.');

  if (tsconfigText !== undefined) checks.push({ id: 'typecheck', label: 'TypeScript', command: ['npx', 'tsc', '--noEmit'], required: true, timeoutMs: 600_000, recommended: true, reason: 'Có tsconfig.json. Check không có report: chỉ exit code quyết định pass/fail và không là bằng chứng cho yêu cầu.' });
  const lintScript = script('lint');
  if (lintScript !== undefined) checks.push({ id: 'lint', label: 'Lint', command: ['npm', 'run', 'lint'], required: true, timeoutMs: 600_000, recommended: true, reason: `Script "lint" (${lintScript.slice(0, 80)}). Bỏ chọn nếu repo đang lỗi lint sẵn.` });
  else if (linters.includes('ESLint')) checks.push({ id: 'lint', label: 'ESLint', command: ['npx', 'eslint', '.'], required: true, timeoutMs: 600_000, recommended: true, reason: 'Có cấu hình ESLint nhưng chưa có script "lint". Bỏ chọn nếu repo đang lỗi lint sẵn.' });
  else if (linters.includes('Biome')) checks.push({ id: 'lint', label: 'Biome', command: ['npx', 'biome', 'check', '.'], required: true, timeoutMs: 600_000, recommended: true, reason: 'Có cấu hình Biome. Bỏ chọn nếu repo đang lỗi sẵn.' });
  if (script('build') !== undefined) checks.push({ id: 'build', label: 'Build', command: ['npm', 'run', 'build'], required: true, timeoutMs: 900_000, recommended: false, reason: 'Script "build" có sẵn; thường chậm, mặc định không chọn.' });

  // pnpm/yarn are .cmd shims that cannot be spawned without a shell on Windows, so route them through npx.
  const npmSetup = planNpmSetup(['npm', 'install'], files.has('package-lock.json') || files.has('npm-shrinkwrap.json'));
  const setupCommand = !pkg ? [] : packageManager === 'pnpm' ? ['npx', '--yes', 'pnpm', 'install', '--frozen-lockfile']
    : packageManager === 'yarn' ? ['npx', '--yes', 'yarn', 'install', '--frozen-lockfile']
      : packageManager === 'bun' ? [] : npmSetup.command;
  if (pkg && packageManager === 'npm' && npmSetup.note) notes.push(npmSetup.note);
  if (packageManager === 'bun') notes.push('Repo dùng Bun: hệ thống chưa chạy được bun trực tiếp, hãy nhập lệnh cài đặt và check thủ công.');

  // Other stacks' checks follow the Node ones; an id already taken (two `test` checks in one repo) gets the tool's name as a prefix.
  const taken = new Set(checks.map((c) => c.id));
  for (const other of others) {
    for (const c of other.checks) {
      const id = taken.has(c.id) ? `${other.buildTool}-${c.id}` : c.id;
      taken.add(id);
      checks.push({ ...c, id });
    }
  }
  // Build checks lead so that a compile error is reported before the tests that cannot run without it.
  checks.sort((a, b) => Number(/(^|-)build$/.test(b.id) && !!b.recommended) - Number(/(^|-)build$/.test(a.id) && !!a.recommended));

  return { packageManager: pkg ? packageManager : others[0]?.buildTool ?? null, languages, frameworks, testRunner, linters, guidance: composeGuidance({ packageManager: pkg ? packageManager : null, extra: others.flatMap((o) => o.guidance), languages, frameworks, testRunner: nodeRunner, e2e, linters, checks, type: pkg?.type === 'module' ? 'ESM' : pkg ? 'CommonJS' : null, jsx: typeof compilerOptions.jsx === 'string' ? compilerOptions.jsx : null }), checks, setupCommand, notes };
}

function composeGuidance(s: { packageManager: string | null; extra: string[]; languages: string[]; frameworks: string[]; testRunner: string | null; e2e: string | null; linters: string[]; checks: SuggestedCheck[]; type: string | null; jsx: string | null }): string {
  const lines: string[] = [];
  if (s.languages.length) lines.push(`Ngôn ngữ: ${s.languages.join(', ')}${s.type ? ` (module ${s.type})` : ''}.`);
  if (s.frameworks.length) lines.push(`Framework/thư viện chính: ${s.frameworks.join(', ')}.`);
  if (s.packageManager) lines.push(`Package manager: ${s.packageManager}. Không đổi package manager, không thêm hay nâng cấp dependency.`);
  lines.push(...s.extra);
  if (s.testRunner || s.e2e) lines.push(`Test: ${[s.testRunner, s.e2e && s.e2e !== s.testRunner ? `${s.e2e} (E2E)` : null].filter(Boolean).join(', ')}. Viết test theo cách các test hiện có đang làm (vị trí file, cách đặt tên, helper).`);
  if (s.linters.length) lines.push(`Công cụ format/lint: ${s.linters.join(', ')}. Tuân theo cấu hình có sẵn, không tắt rule.`);
  const commands = s.checks.filter((c) => c.recommended).map((c) => `${c.label}: ${c.command.join(' ')}`);
  if (commands.length) lines.push(`Lệnh kiểm tra của project: ${commands.join('; ')}. Tự chạy các lệnh này trước khi bàn giao.`);
  lines.push('Quy ước: đọc code lân cận và theo đúng phong cách, cách đặt tên, cấu trúc thư mục và cách xử lý lỗi đang có. Ưu tiên dùng lại thành phần có sẵn.');
  lines.push('Tránh: sửa lockfile hoặc file cấu hình build/test, tắt strict/lint để qua check, thêm dependency mới, thêm abstraction cho yêu cầu chưa có.');
  return lines.join('\n').slice(0, GUIDANCE_MAX_CHARS);
}
