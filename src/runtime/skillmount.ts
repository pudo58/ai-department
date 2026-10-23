import { existsSync } from 'node:fs';
import { appendFile, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ResolvedSkill, RuntimeEvent } from './types.js';

/**
 * Puts a role's approved skills where its CLI looks for them, for one agent turn only. Both helpers return a
 * `dispose` that removes exactly what they added, and the caller runs it in `finally`.
 */

/**
 * Claude Code: a plugin folder outside the working copy, passed with `--plugin-dir`. Nothing touches the repository
 * and the person's own ~/.claude stays unread.
 */
export async function claudeSkillPlugin(dataDir: string, attemptId: string, skills: readonly ResolvedSkill[]): Promise<{ dir: string; dispose: () => Promise<void> }> {
  const dir = path.join(dataDir, 'skill-plugins', attemptId);
  await rm(dir, { recursive: true, force: true });
  await mkdir(path.join(dir, '.claude-plugin'), { recursive: true });
  await writeFile(path.join(dir, '.claude-plugin', 'plugin.json'), `${JSON.stringify({ name: 'aidept-skills', version: '1.0.0', description: 'Skill do AI Department nạp cho lượt này' }, null, 2)}\n`);
  for (const s of skills) await cp(s.dir, path.join(dir, 'skills', s.name), { recursive: true });
  return { dir, dispose: () => rm(dir, { recursive: true, force: true }) };
}

const EXCLUDE_LINE = '.agents/skills/';

/**
 * Codex: `.agents/skills/<name>` inside the working copy, which Codex reads as the repository's skills. The folder is
 * git-ignored through `.git/info/exclude`, so it never shows in the agent's diff, and a skill the repository already
 * has under the same name is left alone.
 */
export async function codexWorkspaceSkills(cwd: string, skills: readonly ResolvedSkill[], onEvent?: (e: RuntimeEvent) => void): Promise<{ installed: string[]; dispose: () => Promise<void> }> {
  const exclude = path.join(cwd, '.git', 'info', 'exclude');
  const current = await readFile(exclude, 'utf8').catch(() => '');
  if (!current.split(/\r?\n/).includes(EXCLUDE_LINE)) {
    await mkdir(path.dirname(exclude), { recursive: true });
    await appendFile(exclude, `\n${EXCLUDE_LINE}\n`);
  }
  const agentsDir = path.join(cwd, '.agents');
  const base = path.join(agentsDir, 'skills');
  const hadAgents = existsSync(agentsDir), hadBase = existsSync(base);
  const installed: string[] = [];
  for (const s of skills) {
    const target = path.join(base, s.name);
    if (existsSync(target)) {
      onEvent?.({ type: 'log', message: `Repo đã có skill "${s.name}" trong .agents/skills; dùng bản của repo, không nạp bản trong thư viện.`, data: { source: 'agent-stderr', level: 'warn' } });
      continue;
    }
    await cp(s.dir, target, { recursive: true });
    installed.push(target);
  }
  return {
    installed,
    dispose: async () => {
      for (const dir of installed) await rm(dir, { recursive: true, force: true });
      if (!hadBase && existsSync(base) && !(await readdir(base)).length) await rm(base, { recursive: true, force: true });
      if (!hadAgents && existsSync(agentsDir) && !(await readdir(agentsDir)).length) await rm(agentsDir, { recursive: true, force: true });
    },
  };
}
