import { readFile } from 'node:fs/promises';

/**
 * Reads a test report written by a check. JSON (Vitest/Jest) is returned parsed; JUnit XML (e.g. from
 * `node --test --test-reporter=junit`) is returned as text for the core parser. Anything else, or a missing
 * file, is `undefined`, which the caller treats as "no report" and therefore an incomplete check.
 */
export async function readReportFile(file: string): Promise<unknown> {
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch { return undefined; }
  try { return JSON.parse(text); } catch { return text.trimStart().startsWith('<') ? text : undefined; }
}
