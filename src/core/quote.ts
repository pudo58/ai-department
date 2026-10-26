/** Matching a quotation against a clause by meaning-free differences only: case, spacing, dashes, quote marks and elided middles. */

/** Folds typographic variants so a quotation can be matched by meaning-free differences only. */
function foldChar(c: string): string {
  return c.normalize('NFKC').replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"').replace(/[‐-―]/g, '-').replace(/[​-‍﻿]/g, '');
}

/** `text` lower-cased with typographic variants folded and whitespace collapsed, and where each kept character came from. */
function foldWithMap(text: string): { folded: string; map: number[] } {
  let folded = '';
  const map: number[] = [];
  let lastSpace = true;
  for (let i = 0; i < text.length; i++) {
    for (const ch of foldChar(text[i]!).toLowerCase()) {
      if (/\s/.test(ch)) { if (lastSpace) continue; lastSpace = true; folded += ' '; map.push(i); }
      else { lastSpace = false; folded += ch; map.push(i); }
    }
  }
  return { folded: folded.replace(/ $/, ''), map };
}

/**
 * The exact text of `source` that `quote` refers to, when `quote` differs from it only in case, spacing, dashes, quote
 * marks or elided middles ("... "). Undefined when the quotation is not in the source at all, which stays an error
 * for a person to look at.
 */
export function snapQuote(quote: string, source: string): string | undefined {
  if (!quote.trim()) return undefined;
  if (source.includes(quote)) return quote;
  const parts = quote.split(/\s*(?:\.{3}|…)\s*/).map(p => foldWithMap(p.trim().replace(/^["'`]+|["'`]+$/g, '')).folded.trim()).filter(Boolean);
  if (!parts.length) return undefined;
  const { folded, map } = foldWithMap(source);
  let from = 0, start = -1, end = -1;
  for (const part of parts) {
    const at = folded.indexOf(part, from);
    if (at < 0) return undefined;
    if (start < 0) start = at;
    end = at + part.length - 1;
    from = at + part.length;
  }
  return source.slice(map[start]!, map[end]! + 1);
}
