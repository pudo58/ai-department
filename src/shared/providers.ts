import type { ProviderName, Role } from './types';

/** Roles whose whole output is text: they read the repository but never change it (Author writes tests, Developer writes code). */
export const READ_ONLY_ROLES: readonly Role[] = ['planner', 'verifier', 'investigator'];
/**
 * Antigravity as Developer or Author is experimental: per-turn permission rules keep its edits inside the working copy,
 * and it cannot run any command, so the checks AI Department runs afterwards are the only time its code is executed.
 */
export const isExperimental = (provider: ProviderName, role: Role): boolean => provider === 'antigravity' && !READ_ONLY_ROLES.includes(role);
export const PROVIDER_LABEL: Record<ProviderName, string> = { codex: 'Codex', claude: 'Claude', antigravity: 'Antigravity', fake: 'Mô phỏng' };
