export type ScopeVerdict = 'allowed' | 'protected' | 'needs_approval';

const escapeChar = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/** Minimal glob: `**` spans directories, `*` and `?` stay within one path segment. */
export function globToRegExp(glob: string): RegExp {
  const g = normalizePath(glob);
  let out = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*' && g[i + 1] === '*') {
      const slash = g[i + 2] === '/';
      out += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += escapeChar(c);
  }
  return new RegExp(`^${out}$`);
}

/** A path with traversal or absolute components can never be in scope. */
export function isSafeRelative(p: string): boolean {
  const n = p.replace(/\\/g, '/');
  return !!n && !n.startsWith('/') && !/^[A-Za-z]:/.test(n) && !n.split('/').includes('..') && !n.includes('\0');
}

/** Default protected set: anything that can weaken verification or change the dependency graph. */
export const DEFAULT_PROTECTED = [
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'package.json',
  'vitest.config.*', 'jest.config.*', 'playwright.config.*', 'vite.config.*', 'tsconfig*.json',
  '.github/**', '.npmrc', 'Dockerfile', 'docker-compose*.yml',
];

/**
 * Project setup files an agent may CREATE in a project that opted in (a new project has none yet). A file of this kind
 * that already existed in the run's base snapshot stays protected, so existing check configuration cannot be weakened.
 */
export const SCAFFOLDABLE = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'tsconfig*.json', 'vite.config.*', 'vitest.config.*', 'jest.config.*', 'playwright.config.*'];

export interface ScopeInput {
  modules: readonly string[]; protectedPaths: readonly string[]; lockedPaths?: readonly string[];
  /** When set, protected setup files absent from the base snapshot may be created (and then edited) by the agent. */
  scaffold?: { baseFiles: ReadonlySet<string> };
}

export function classifyPath(path: string, scope: ScopeInput): ScopeVerdict {
  if (!isSafeRelative(path)) return 'protected';
  const p = normalizePath(path);
  const name = p.split('/').pop() ?? p;
  const hits = (globs: readonly string[]) => globs.some((g) => { const re = globToRegExp(g); return re.test(p) || (!g.includes('/') && re.test(name)); });
  if (hits(scope.lockedPaths ?? [])) return 'protected';
  const newSetupFile = !!scope.scaffold && hits(SCAFFOLDABLE) && !scope.scaffold.baseFiles.has(p);
  if (hits(scope.protectedPaths) && !newSetupFile) return 'protected';
  const inModule = scope.modules.some((m) => {
    const base = normalizePath(m).replace(/\/+$/, '');
    return p === base || p.startsWith(`${base}/`) || globToRegExp(m).test(p);
  });
  return inModule ? 'allowed' : 'needs_approval';
}

export interface ScopeReport { allowed: string[]; protected: string[]; needsApproval: string[]; accepted: boolean }

/** A checkpoint is only accepted when every touched file is inside an allowed module. */
export function evaluateChanges(files: readonly string[], scope: ScopeInput): ScopeReport {
  const report: ScopeReport = { allowed: [], protected: [], needsApproval: [], accepted: false };
  for (const f of files) {
    const v = classifyPath(f, scope);
    (v === 'allowed' ? report.allowed : v === 'protected' ? report.protected : report.needsApproval).push(f);
  }
  report.accepted = !report.protected.length && !report.needsApproval.length;
  return report;
}
