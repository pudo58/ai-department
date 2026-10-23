import { readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

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

const WILDCARD = /[*?]/;
const MAX_WALK = 20_000;
const MAX_REPORT_BYTES = 20 * 1024 * 1024;

const segmentPattern = (segment: string): RegExp =>
  new RegExp(`^${segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);

// Paths (files or folders) under `root` matching a pattern with `*`, `?` and `**` segments (any depth), for example
// a double-star segment followed by target/surefire-reports.
async function expand(root: string, pattern: string): Promise<string[]> {
  const segments = pattern.replace(/\\/g, '/').split('/').filter(Boolean);
  const found = new Set<string>();
  let budget = MAX_WALK;
  const entriesOf = async (dir: string) => { try { return await readdir(dir, { withFileTypes: true }); } catch { return []; } };
  const walk = async (dir: string, i: number): Promise<void> => {
    if (i === segments.length) { found.add(dir); return; }
    const segment = segments[i]!;
    if (segment === '**') {
      await walk(dir, i + 1);
      for (const e of await entriesOf(dir)) {
        if (--budget < 0) return;
        if (e.isDirectory() && !e.isSymbolicLink() && e.name !== 'node_modules' && e.name !== '.git') await walk(path.join(dir, e.name), i);
      }
      return;
    }
    if (!WILDCARD.test(segment)) {
      const next = path.join(dir, segment);
      try { await stat(next); } catch { return; }
      return walk(next, i + 1);
    }
    const re = segmentPattern(segment);
    for (const e of await entriesOf(dir)) {
      if (--budget < 0) return;
      if (!e.isSymbolicLink() && re.test(e.name)) await walk(path.join(dir, e.name), i + 1);
    }
  };
  await walk(root, 0);
  return [...found];
}

/**
 * The report files a `reportPath` stands for. It may be one file, a folder (every .xml directly inside it: Maven writes
 * target/surefire-reports/TEST-*.xml and Gradle build/test-results/test/TEST-*.xml, one per test class) or a pattern
 * with wildcards for multi-module builds.
 */
export async function reportFiles(root: string, reportPath: string): Promise<string[]> {
  const targets = WILDCARD.test(reportPath) ? await expand(root, reportPath) : [path.join(root, reportPath)];
  const files: string[] = [];
  for (const target of targets) {
    let info;
    try { info = await stat(target); } catch { continue; }
    if (info.isDirectory()) {
      try { files.push(...(await readdir(target, { withFileTypes: true })).filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.xml')).map((e) => path.join(target, e.name)).sort()); } catch { /* unreadable folder: no report */ }
    } else if (info.isFile()) files.push(target);
  }
  return files;
}

/** Removes the previous run's report files so they can never be mistaken for this run's output. Only the files themselves go, never a folder. */
export async function clearReport(root: string, reportPath: string): Promise<void> {
  for (const file of await reportFiles(root, reportPath)) await rm(file, { force: true });
}

const XML_PROLOG = /^\s*<\?xml[^>]*\?>\s*/;

/** One report as the core parser wants it: parsed JSON, XML text, or several JUnit files merged under one root. */
export async function readReport(root: string, reportPath: string): Promise<unknown> {
  const files = await reportFiles(root, reportPath);
  if (files.length === 0) return undefined;
  if (files.length === 1) return readReportFile(files[0]!);
  const bodies: string[] = [];
  for (const file of files) {
    try {
      if ((await stat(file)).size > MAX_REPORT_BYTES) continue;
      const text = await readFile(file, 'utf8');
      if (/<testsuites?[\s>]/.test(text)) bodies.push(text.replace(XML_PROLOG, ''));
    } catch { /* an unreadable file is simply not part of the report */ }
  }
  return bodies.length ? `<testsuites>${bodies.join('\n')}</testsuites>` : undefined;
}
