// node scripts/check-client.mjs
// The page runs in a browser: no `process`, no `Buffer`, no `node:*` modules. TypeScript alone cannot say which shared modules the
// page really loads (an `import type` still pulls a file into the program), so this builds the page, takes the modules that end up in
// the bundle, and reports what tsconfig.client.json (no Node types) says about exactly those files. Whatever it prints would throw
// in a browser and the compiler for the server would never notice.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { build } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundled = new Set(), nodeModules = new Set();
const record = {
  name: 'record-bundled-modules',
  generateBundle(_, bundle) {
    for (const chunk of Object.values(bundle)) {
      if (chunk.type !== 'chunk') continue;
      for (const id of Object.keys(chunk.modules)) {
        const clean = id.split('?')[0];
        if (clean.includes('__vite-browser-external')) nodeModules.add(clean.replace(/^.*__vite-browser-external:?/, '') || clean);
        else bundled.add(path.normalize(clean));
      }
    }
  },
};
await build({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'silent', plugins: [record], build: { write: false, minify: false } });

const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); } };
const parsed = ts.getParsedCommandLineOfConfigFile(path.join(root, 'tsconfig.client.json'), {}, host);
const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
const problems = ts.getPreEmitDiagnostics(program).filter((d) => d.file && bundled.has(path.normalize(d.file.fileName)));

for (const name of nodeModules) console.error(`The page bundle contains the Node module "${name}", which does not exist in a browser.`);
for (const d of problems) {
  const { line, character } = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
  console.error(`${path.relative(root, d.file.fileName).replace(/\\/g, '/')}(${line + 1},${character + 1}): TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
}
if (nodeModules.size || problems.length) process.exit(1);
console.log(`The page bundle has ${bundled.size} modules; none uses Node-only APIs.`);
