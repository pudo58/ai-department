import type { TestIdentity } from '../shared/quality.js';

/** Only paths are normalized. Test titles are never case-folded or split on punctuation. */
export function normalizeTestId(id: string, workspace?: string): string {
  if (id.startsWith('@json:') || id.startsWith('@junit:')) return id;
  const separator = id.indexOf('::');
  const path = separator < 0 ? id : id.slice(0, separator);
  const suffix = separator < 0 ? '' : id.slice(separator);
  const normalized = path.replace(/\\/g, '/');
  const root = workspace?.replace(/\\/g, '/').replace(/\/$/, '');
  const sameRoot = root && (/^[A-Za-z]:\//.test(root) ? normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`) : normalized.startsWith(`${root}/`));
  return (sameRoot ? normalized.slice(root!.length + 1) : normalized.replace(/^\.\//, '')) + suffix;
}
export function identityId(identity: TestIdentity, workspace?: string): string {
  return identity.kind === 'json'
    ? `@json:${JSON.stringify([normalizeTestId(identity.file, workspace), identity.titles])}`
    : `@junit:${JSON.stringify([identity.className, identity.name])}`;
}
export function testTitle(id: string): string {
  try {
    if (id.startsWith('@json:')) return (JSON.parse(id.slice(6))[1] as string[]).join(' ');
    if (id.startsWith('@junit:')) return JSON.parse(id.slice(7)).join(' ');
  } catch { /* malformed identities never gain evidence */ }
  return id;
}
/** A test as a person reads it: its name, then the file it is in. Anything that is not a structured id comes back unchanged. */
export function describeTest(id: string): string {
  try {
    if (id.startsWith('@json:')) { const [file, titles] = JSON.parse(id.slice(6)) as [string, string[]]; return `“${titles.join(' › ')}” (${file.replace(/\\/g, '/')})`; }
    if (id.startsWith('@junit:')) { const [where, name] = JSON.parse(id.slice(7)) as [string, string]; return `“${name}” (${where.replace(/\\/g, '/')})`; }
  } catch { /* an unreadable id is shown as it is */ }
  return id;
}
/**
 * For text a person reads (a banner, a list): every structured test id in it becomes the test's name and file. The ids stay as they
 * are in the data and in what the agents are told, because a diagnosis has to quote them exactly.
 */
export function humanizeTestIds(text: string): string {
  return text.replace(/@(?:json|junit):\[(?:"(?:[^"\\]|\\.)*"|[[\],\s])*\]/g, describeTest);
}
export function extractCaseIds(title: string): string[] {
  title = testTitle(title);
  const bracketed = [...title.matchAll(/\[([^\]]+)\]/g)].flatMap((m) => m[1]!.split(/[\s,;]+/)).filter((t) => /^C-[A-Za-z0-9_-]+$/.test(t));
  return [...new Set([...bracketed, ...[...title.matchAll(/(?<![A-Za-z0-9[])C_(\d+)(?![A-Za-z0-9])/g)].map((m) => `C-${m[1]}`)])];
}
