// Typechecks the Figma Exporter plugin: the main code against the pinned @figma/plugin-typings, the UI against the DOM.
//   node scripts/check-exporter.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
let failed = false;
for (const config of ['tsconfig.main.json', 'tsconfig.ui.json']) {
  const result = spawnSync(process.execPath, [tsc, '-p', path.join(root, 'plugins', 'figma-exporter', config)], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) failed = true;
  else console.log(`✓ ${config}`);
}
process.exit(failed ? 1 : 0);
