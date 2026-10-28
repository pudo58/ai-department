import { angularTestInfo, parseLooseJson, readInside } from '../core/stackdetect.js';

/** Only plain npm scripts are adapted; shell wrappers keep their configured behavior. */
export async function planAngularCheck(command: readonly string[], cwd: string): Promise<{ command: string[]; angular?: boolean; note?: string; problem?: string }> {
  const unchanged = { command: [...command] };
  if (!['npm', 'npm.cmd'].includes(command[0] ?? '')) return unchanged;
  const scriptIndex = ['run', 'run-script'].includes(command[1] ?? '') ? 2 : 1;
  const scriptName = command[scriptIndex];
  if (!scriptName || command.some(arg => /^(?:--prefix|--workspace|-w|-C)(?:=|$)/.test(arg))) return unchanged;
  const pkg = parseLooseJson(await readInside(cwd, 'package.json') ?? '');
  const scripts = pkg?.scripts as Record<string, unknown> | undefined;
  const script = scripts?.[scriptName];
  if (typeof script !== 'string') return unchanged;
  const info = await angularTestInfo(cwd, script);
  if (!info) return unchanged;
  const args = command.slice(scriptIndex + 1).filter(arg => arg !== '--');
  const badFlags = args.some(arg => /^(?:--run|--reporter|--outputFile)(?:=|$)/.test(arg));
  if (!info.supported) return { ...unchanged, ...(badFlags ? { problem: info.reason } : {}) };
  const normalized = args.map(arg => arg === '--run' || arg === '--run=true' ? '--watch=false'
    : arg.replace(/^--reporter(?==|$)/, '--reporters').replace(/^--outputFile(?==|$)/, '--output-file'));
  const adapted = [...command.slice(0, scriptIndex + 1), ...(normalized.length ? ['--', ...normalized] : [])];
  return { command: adapted, angular: true, ...(JSON.stringify(adapted) !== JSON.stringify(command) ? { note: 'Script test dùng Angular: chuyển cờ Vitest sang --watch=false, --reporters và --output-file; giữ nguyên script và phạm vi test.' } : {}) };
}
