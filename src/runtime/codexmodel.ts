import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const HEAD_BYTES = 64 * 1024;

/**
 * The model Codex actually used for a session. `codex exec --json` does not report it when no --model is given, but
 * the session log Codex writes (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-…-<sessionId>.jsonl`) records it near the top.
 * Read-only: looks in the folder of the session's start day and the day after (sessions can cross midnight), reads
 * at most 64 KB, and returns undefined when anything is missing.
 */
export async function resolveCodexModel(sessionId: string, startedAt: string, codexHome = process.env.CODEX_HOME ?? path.join(homedir(), '.codex')): Promise<string | undefined> {
  if (!/^[A-Za-z0-9-]{8,80}$/.test(sessionId)) return undefined;
  const start = new Date(startedAt);
  if (Number.isNaN(start.getTime())) return undefined;
  const days = [0, 1, -1].map((d) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + d));
  for (const day of days) {
    const dir = path.join(codexHome, 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
    let names: string[];
    try { names = await readdir(dir); } catch { continue; }
    const file = names.find((n) => n.endsWith(`-${sessionId}.jsonl`));
    if (!file) continue;
    const handle = await open(path.join(dir, file), 'r');
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0);
      const model = /"model"\s*:\s*"([A-Za-z0-9._:/-]{1,80})"/.exec(buf.subarray(0, bytesRead).toString('utf8'))?.[1];
      if (model) return model;
    } finally { await handle.close(); }
  }
  return undefined;
}
