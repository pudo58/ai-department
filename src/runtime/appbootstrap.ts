import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { Toolchains } from './toolchain.js';

/** Kept in a separate Node-18-compatible bundle: no SQLite or server imports before re-exec. */
export async function ensureAppRuntime(home: string) {
  const root = await new Toolchains({ dataDir: path.join(home, 'runtime') }).ensureNode(console.log);
  const bin = process.platform === 'win32' ? root : path.join(root, 'bin');
  const npmRoot = path.join(root, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', 'npm');
  const npmVersion: string = JSON.parse(await readFile(path.join(npmRoot, 'package.json'), 'utf8')).version;
  return { node: path.join(bin, process.platform === 'win32' ? 'node.exe' : 'node'), npm: path.join(npmRoot, 'bin', 'npm-cli.js'), bin, npmVersion };
}
