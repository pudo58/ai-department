import { isTestPath } from './testpath.js';

/** Lockfiles, build output, minified bundles and snapshots: large, machine-written, and nothing a reviewer can judge. */
const GENERATED = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|Pipfile\.lock|composer\.lock|gradle\.lockfile)$|(^|\/)(dist|build|target|coverage|out|node_modules)\/|\.min\.(js|css)$|\.map$|\.snap$/;

interface FilePatch { path: string; text: string }

function splitPatch(patch: string): FilePatch[] {
  return patch.split(/(?=^diff --git )/m).filter((chunk) => chunk.startsWith('diff --git ')).map((text) => ({
    path: /^diff --git a\/.+? b\/(.+)$/m.exec(text)?.[1] ?? '?',
    text: text.endsWith('\n') ? text : `${text}\n`,
  }));
}

/**
 * The diff a Verifier reads: every change since the base snapshot (not just the last repair round), within a character
 * budget. Generated files are named but not shown; code comes before tests; a file too long for what is left is cut
 * at a line boundary and says so, and anything that did not fit is listed by name, so the reviewer knows what it did
 * not see instead of reading a diff that silently stops mid-file.
 */
export function reviewDiff(patch: string, maxChars = 60_000): string {
  const files = splitPatch(patch);
  if (!files.length) return patch.slice(0, maxChars);
  const generated = files.filter((f) => GENERATED.test(f.path));
  const reviewable = files.filter((f) => !GENERATED.test(f.path));
  const ordered = [...reviewable.filter((f) => !isTestPath(f.path)), ...reviewable.filter((f) => isTestPath(f.path))];
  // Room for the closing notes, which name what was left out.
  const notesRoom = Math.min(2000, Math.floor(maxChars / 10));
  let budget = maxChars - notesRoom;
  const parts: string[] = [], skipped: string[] = [], cut: string[] = [];
  for (const f of ordered) {
    if (f.text.length <= budget) { parts.push(f.text); budget -= f.text.length; continue; }
    if (budget < 400) { skipped.push(f.path); continue; }
    const lines = f.text.split('\n');
    let kept = '';
    let n = 0;
    for (const line of lines) {
      if (kept.length + line.length + 1 > budget - 120) break;
      kept += `${line}\n`; n++;
    }
    const note = `… (cắt bớt ${lines.length - n} dòng còn lại của ${f.path})\n`;
    parts.push(kept + note);
    budget -= kept.length + note.length;
    cut.push(f.path);
  }
  const notes = [
    cut.length ? `File bị cắt bớt vì diff quá dài: ${cut.join(', ')}.` : '',
    skipped.length ? `File không đưa vào vì diff quá dài (tự mở trong workspace nếu cần): ${skipped.join(', ')}.` : '',
    generated.length ? `File sinh tự động/lockfile không hiển thị: ${generated.map((f) => f.path).join(', ')}.` : '',
  ].filter(Boolean).join('\n');
  return `${parts.join('')}${notes ? `\n${notes.slice(0, notesRoom)}` : ''}`;
}
