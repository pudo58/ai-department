// A parent watchdog also stops the process group after an ungraceful server exit.
const { spawn } = require('node:child_process');
const [parent, executable, ...args] = process.argv.slice(2);
const path = require('node:path');
const { createRequire } = require('node:module');
const installed = createRequire(path.resolve('package.json'));
const commandArgs = args[0] === '--stryker-installed' ? [path.join(path.dirname(installed.resolve('@stryker-mutator/core/package.json')), 'bin/stryker.js'), ...args.slice(1)] : args;
const child = spawn(executable, commandArgs, { stdio: 'inherit', shell: false, windowsHide: true, detached: process.platform !== 'win32' });
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}
const watchdog = setInterval(() => { if (Number(parent) > 0) { try { process.kill(Number(parent), 0); } catch { stop(); } } }, 500);
process.on('SIGTERM', stop); process.on('SIGINT', stop);
child.on('error', error => { clearInterval(watchdog); console.error(error.message); process.exitCode = 1; });
child.on('close', code => { clearInterval(watchdog); process.exitCode = code ?? 1; });
