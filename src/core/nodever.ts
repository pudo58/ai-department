import path from 'node:path';

export interface NodeVersion { major: number; minor: number; patch: number }

/** Log prefix for a check that was never started because the machine cannot run it; the orchestrator shows the rest verbatim. */
export const ENV_PROBLEM_PREFIX = 'Môi trường không chạy được check: ';

export function parseNodeVersion(text: string | undefined): NodeVersion | undefined {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(text ?? '');
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : undefined;
}

export const formatNodeVersion = (v: NodeVersion): string => `v${v.major}.${v.minor}.${v.patch}`;

/** Node runs .ts files by itself from 22.18 (23.6 on the odd-numbered line). */
export const stripsTypes = (v: NodeVersion): boolean => v.major >= 24 || (v.major === 23 && v.minor >= 6) || (v.major === 22 && v.minor >= 18);

export function isNodeTestCommand(command: readonly string[]): boolean {
  const base = path.win32.basename(command[0] ?? '').toLowerCase().replace(/\.exe$/, '');
  return base === 'node' && command.slice(1).includes('--test');
}

/**
 * Why `node --test ...` cannot work with this Node, or undefined when it can (or when the version is unknown).
 * Commands run without a shell, so `*` patterns are only expanded by node itself, and only from Node 21.
 */
export function nodeTestProblem(command: readonly string[], version: NodeVersion | undefined): string | undefined {
  if (!version || !isNodeTestCommand(command)) return undefined;
  const args = command.slice(1).filter((a) => !a.startsWith('-'));
  const shown = formatNodeVersion(version);
  const hasGlob = args.some((a) => /[*?{]/.test(a));
  if (version.major < 21 && (hasGlob || command.some((a) => a.includes('junit')))) {
    return `node ${shown} quá cũ cho lệnh "node --test": mẫu file có dấu * và report JUnit cần Node 21 trở lên (Node cũ báo "Could not find '...*.spec.ts'"). Cài Node 22.18 trở lên, hoặc đổi check sang test runner của project (npm test, Jest, Vitest).`;
  }
  if (!stripsTypes(version) && args.some((a) => /\.[cm]?tsx?$/.test(a))) {
    return `node ${shown} không chạy trực tiếp file .ts bằng "node --test" (cần Node 22.18 trở lên). Cài Node mới hơn, hoặc đổi check sang test runner của project (Jest, Vitest, ts-node...).`;
  }
  return undefined;
}

/**
 * Decides which Node runs a `node --test` check. When the Node on PATH is too old but the Node running AI Department
 * is fine, that one is used (and the note says so); when neither works, the check is not started and `problem` says why.
 */
export function planNodeTest(command: readonly string[], onPath: NodeVersion | undefined, own: NodeVersion | undefined, ownExecutable: string): { command: string[]; note?: string; problem?: string } {
  const problem = nodeTestProblem(command, onPath);
  if (!problem) return { command: [...command] };
  if (own && !nodeTestProblem(command, own)) {
    return { command: [ownExecutable, ...command.slice(1)], note: `Node trong PATH là ${formatNodeVersion(onPath!)} quá cũ cho "node --test"; dùng Node của AI Department (${formatNodeVersion(own)}) cho check này.` };
  }
  return { command: [...command], problem };
}
