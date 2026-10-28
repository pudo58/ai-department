// Builds the AI Department Exporter (a Figma plugin) and prepares it for one AI Department instance.
//
//   node scripts/build-figma-exporter.mjs            builds plugins/figma-exporter/dist (the template; not tied to any port)
//
// `buildExporter` bundles the main code (an IIFE for Figma's sandbox) and the UI (inlined into one HTML file).
// `prepareBundle` turns the template into a folder to import in Figma: it writes the manifest and the UI for one origin, and records
// the version of the protocol and reader and the hash of every file in bundle-manifest.json.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_DIR = path.join(here, 'dist');
const PLUGIN_VERSION = '1.1.1', PROTOCOL_VERSION = 1, READER_VERSION = 1;

const sha = (data) => createHash('sha256').update(data).digest('hex');
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
};

function esbuild() {
  // esbuild is not a direct dependency; Vite depends on it, so load the copy Vite brings.
  return createRequire(createRequire(import.meta.url).resolve('vite'))('esbuild');
}

/** Bundles the plugin into `outDir` as a template. Safe to run again: the folder is rebuilt from scratch. */
export async function buildExporter({ outDir = TEMPLATE_DIR } = {}) {
  const { build } = esbuild();
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const common = { bundle: true, format: 'iife', target: 'es2020', legalComments: 'none', logLevel: 'warning', write: false, minify: false };
  const main = await build({ ...common, entryPoints: [path.join(here, 'src/main/index.ts')], platform: 'neutral' });
  const ui = await build({ ...common, entryPoints: [path.join(here, 'src/ui/ui.ts')], platform: 'browser' });
  const code = main.outputFiles[0].text;
  // Main runs in Figma's sandbox, which has no Node and no module loader: anything left over would fail at runtime, not here.
  if (/\brequire\(|\bimport\s*\(|^\s*import\s/m.test(code)) throw new Error('Bundle main còn lệnh import/require.');
  const script = ui.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  writeFileSync(path.join(outDir, 'code.js'), code);
  writeFileSync(path.join(outDir, 'ui.template.html'), readFileSync(path.join(here, 'ui.template.html'), 'utf8').replace('/*__UI_SCRIPT__*/', () => script));
  writeFileSync(path.join(outDir, 'README.template.md'), readFileSync(path.join(here, 'README.template.md'), 'utf8'));
  return { outDir, codeSha: sha(code) };
}

/**
 * Writes the importable folder for an instance's loopback origin. Figma's manifest validator rejects IP literals, so the manifest
 * and the UI both use localhost at the same port. `origin` in the bundle metadata still identifies the owning server instance.
 * The bundle hash includes the plugin's connection origin so existing pairings cannot silently reuse a different network target.
 */
export function prepareBundle({ templateDir = TEMPLATE_DIR, outDir, origin }) {
  const match = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):([1-9]\d{0,4})$/.exec(origin);
  if (!match || Number(match[1]) > 65535) throw new Error(`Origin không hợp lệ: ${origin}. Chỉ nhận HTTP loopback với cổng từ 1 đến 65535.`);
  const pluginOrigin = `http://localhost:${match[1]}`;
  const code = readFileSync(path.join(templateDir, 'code.js'), 'utf8');
  const ui = readFileSync(path.join(templateDir, 'ui.template.html'), 'utf8');
  const bundleHash = sha(canonical({ code: sha(code), ui: sha(ui), origin, pluginOrigin, pluginVersion: PLUGIN_VERSION, protocolVersion: PROTOCOL_VERSION, readerVersion: READER_VERSION }));
  const config = { origin: pluginOrigin, bundleHash, pluginVersion: PLUGIN_VERSION };
  const manifest = {
    name: 'AI Department Exporter', api: '1.0.0', main: 'code.js', ui: 'ui.html', editorType: ['figma'], documentAccess: 'dynamic-page',
    networkAccess: { allowedDomains: ['none'], devAllowedDomains: [pluginOrigin], reasoning: 'Gửi dữ liệu thiết kế đã đọc tới AI Department chạy trên máy này.' },
  };
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const files = {
    'code.js': code,
    'ui.html': ui.replace('null;</script>', () => `${JSON.stringify(config).replace(/</g, '\\u003c')};</script>`).replace('/*__AIDEPT_CONFIG__*/', ''),
    'manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'README.md': readFileSync(path.join(templateDir, 'README.template.md'), 'utf8').replaceAll('__ORIGIN__', pluginOrigin),
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(outDir, name), content);
  const info = { pluginVersion: PLUGIN_VERSION, protocolVersion: PROTOCOL_VERSION, readerVersion: READER_VERSION, origin, bundleHash, files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, sha(content)])) };
  writeFileSync(path.join(outDir, 'bundle-manifest.json'), `${JSON.stringify(info, null, 2)}\n`);
  return info;
}

/** Whether a prepared folder still matches its own bundle-manifest.json (nobody edited a file, nothing is missing). */
export function verifyBundle(dir) {
  try {
    const info = JSON.parse(readFileSync(path.join(dir, 'bundle-manifest.json'), 'utf8'));
    const problems = [];
    for (const [name, hash] of Object.entries(info.files)) {
      const file = path.join(dir, name);
      if (!existsSync(file)) problems.push(`Thiếu ${name}`);
      else if (sha(readFileSync(file, 'utf8')) !== hash) problems.push(`${name} đã bị sửa`);
    }
    return { ok: problems.length === 0, info, problems };
  } catch (error) { return { ok: false, info: undefined, problems: [`Không đọc được bundle-manifest.json: ${error.message}`] }; }
}

export function copyTemplate(from, to) { cpSync(from, to, { recursive: true }); }
