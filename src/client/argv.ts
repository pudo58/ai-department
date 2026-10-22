/**
 * Commands are stored as argv arrays (run without a shell). People type them as a plain command line, so the forms
 * convert both ways: `npm run dev -- --port 3000` ⇄ ["npm","run","dev","--","--port","3000"]. A JSON array is still
 * accepted for arguments that are awkward to quote.
 */

/** Splits a command line on spaces; double or single quotes keep spaces inside one argument. Throws on a stray quote. */
export function parseCommandLine(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    let value: unknown;
    try { value = JSON.parse(trimmed); } catch { throw new Error('Lệnh dạng JSON không hợp lệ, ví dụ ["npm", "ci"].'); }
    if (!Array.isArray(value) || !value.every((x) => typeof x === 'string')) throw new Error('Lệnh dạng JSON phải là mảng các chuỗi, ví dụ ["npm", "ci"].');
    return value;
  }
  const args: string[] = [];
  let current = '', quote: '"' | "'" | null = null, started = false;
  for (const ch of trimmed) {
    if (quote) {
      if (ch === quote) quote = null; else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch; started = true;
    } else if (/\s/.test(ch)) {
      if (started) { args.push(current); current = ''; started = false; }
    } else {
      current += ch; started = true;
    }
  }
  if (quote) throw new Error('Lệnh thiếu dấu nháy đóng.');
  if (started) args.push(current);
  return args;
}

/** The command line people read and edit; arguments with spaces or quotes are wrapped in quotes. */
export function formatCommandLine(argv: readonly string[]): string {
  return argv.map((a) => (a === '' || /[\s"']/.test(a) ? (a.includes('"') ? `'${a}'` : `"${a}"`) : a)).join(' ');
}

/** Last folder name of a Windows or POSIX path, used as the default project name. */
export function folderName(path: string): string {
  return path.trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
}
