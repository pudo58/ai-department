// Builds AI Department for another machine. The target only needs Node.js 24+; nothing is downloaded at install time.
//
//   npm run package                  release/ai-department/ (the package folder), an npm tarball and a portable zip
//   npm run package -- --with-data   the zip also carries a snapshot of this machine's database (never the npm tarball)
//
// Publishing is a separate, deliberate step:  npm publish release/ai-department
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const withData = process.argv.includes('--with-data');
const releaseDir = path.join(root, 'release');
const out = path.join(releaseDir, 'ai-department');
const step = (text) => console.log(`\n▸ ${text}`);
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && !path.isAbsolute(cmd) });

rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, 'app'), { recursive: true });

step('Kiểm tra kiểu (tsc)');
run(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit']);

step('Build giao diện (vite)');
const vite = await import('vite');
await vite.build({ root, logLevel: 'warn' });
cpSync(path.join(root, 'dist', 'client'), path.join(out, 'dist', 'client'), { recursive: true });

step('Gói server thành một file (esbuild)');
// esbuild is not a direct dependency; Vite depends on it, so load the copy Vite brings.
const esbuild = createRequire(fileURLToPath(import.meta.resolve('vite')))('esbuild');
// Bundled CommonJS packages expect require/__dirname; give them ones that work inside an ES module.
const banner = [
  "import { createRequire as __aideptRequire } from 'node:module';",
  "import { fileURLToPath as __aideptPath } from 'node:url';",
  "import { dirname as __aideptDir } from 'node:path';",
  'const require = __aideptRequire(import.meta.url);',
  'const __filename = __aideptPath(import.meta.url);',
  'const __dirname = __aideptDir(__filename);',
].join('\n');
await esbuild.build({
  entryPoints: { server: path.join(root, 'src/server/main.ts'), attest: path.join(root, 'src/server/attest.ts') },
  outdir: path.join(out, 'app'), outExtension: { '.js': '.mjs' },
  bundle: true, platform: 'node', target: 'node24', format: 'esm', banner: { js: banner },
  legalComments: 'none', logLevel: 'warning',
});
cpSync(path.join(root, 'scripts', 'cli.mjs'), path.join(out, 'app', 'cli.mjs'));

step('Chép công cụ, mẫu Docker, script khởi động và hướng dẫn');
cpSync(path.join(root, 'tools'), path.join(out, 'tools'), { recursive: true });
cpSync(path.join(root, 'docker'), path.join(out, 'docker'), { recursive: true });
cpSync(path.join(root, 'scripts', 'release', 'README.md'), path.join(out, 'README.md'));
cpSync(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'));
// cmd.exe expects CRLF line endings; the shell script must keep LF.
writeFileSync(path.join(out, 'start.cmd'), readFileSync(path.join(root, 'scripts', 'release', 'start.cmd'), 'utf8').replace(/\r?\n/g, '\r\n'));
writeFileSync(path.join(out, 'start.sh'), readFileSync(path.join(root, 'scripts', 'release', 'start.sh'), 'utf8').replace(/\r\n/g, '\n'), { mode: 0o755 });

// The published manifest: no dependencies (everything is bundled), one command, and only the files listed here.
// It installs on Node 18+: the launcher fetches its own Node 24 when the machine's Node is older.
const manifest = {
  name: 'ai-department', version: source.version,
  description: 'Phòng làm việc của các AI viết code (Codex, Claude Code, Antigravity) chạy trên máy bạn: giao việc, kiểm chứng, nghiệm thu.',
  type: 'module', bin: { 'ai-department': 'app/cli.mjs' }, engines: { node: '>=18' },
  files: ['app/', 'dist/', 'tools/', 'docker/', 'start.cmd', 'start.sh', 'README.md', 'LICENSE'],
  keywords: ['ai', 'codex', 'claude', 'agents', 'code-review'], license: source.license ?? 'UNLICENSED',
};
writeFileSync(path.join(out, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

step('Tạo gói npm (npm pack)');
// Under `npm run`, npm_execpath is npm's own script, so it runs without a shell.
if (process.env.npm_execpath?.endsWith('.js')) run(process.execPath, [process.env.npm_execpath, 'pack', '--pack-destination', releaseDir, '--loglevel', 'warn'], out);
else run('npm', ['pack', '--pack-destination', releaseDir, '--loglevel', 'warn'], out);
const tarball = path.join(releaseDir, `ai-department-${source.version}.tgz`);

if (withData) {
  step('Chụp dữ liệu (chỉ cho bản zip)');
  const db = path.join(root, '.data', 'ai-department.sqlite');
  if (!existsSync(db)) throw new Error(`Không thấy ${db}`);
  mkdirSync(path.join(out, '.data'), { recursive: true });
  // VACUUM INTO writes a consistent copy even while the server is running; working copies are left behind on purpose.
  new DatabaseSync(db, { readOnly: true }).exec(`VACUUM INTO '${path.join(out, '.data', 'ai-department.sqlite').replaceAll("'", "''")}'`);
  const attestations = path.join(root, '.data', 'attestations');
  if (existsSync(attestations)) cpSync(attestations, path.join(out, '.data', 'attestations'), { recursive: true });
}

step('Nén bản mang đi');
const zipName = `ai-department-${source.version}-portable${withData ? '-kem-du-lieu' : ''}.zip`;
rmSync(path.join(releaseDir, zipName), { force: true });
if (process.platform === 'win32') run(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', zipName, 'ai-department'], releaseDir);
else run('zip', ['-qr', zipName, 'ai-department'], releaseDir);
if (withData) rmSync(path.join(out, '.data'), { recursive: true, force: true });

const size = (file) => `${(statSync(file).size / 1024 / 1024).toFixed(1)} MB`;
console.log(`\nXong.
  Thư mục gói:   ${path.relative(root, out)}
  Gói npm:       ${path.relative(root, tarball)} (${size(tarball)})
  Bản mang đi:   ${path.relative(root, path.join(releaseDir, zipName))} (${size(path.join(releaseDir, zipName))})${withData ? '  ← có dữ liệu của máy này, đừng chia sẻ công khai' : ''}

Cài thử gói npm:   npm install -g .${path.sep}${path.relative(root, tarball)}
Đăng lên npm:      npm login, rồi npm publish .${path.sep}${path.relative(root, out)}`);
