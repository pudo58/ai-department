/** Page sizes offered under a table. */
export const PAGE_SIZES = [10, 20, 50] as const;
export type PageSize = typeof PAGE_SIZES[number];

/** Number of pages for `total` rows (at least one, so an empty table still has page 1). */
export const pageCount = (total: number, size: number) => Math.max(1, Math.ceil(total / size));

/** Keeps a page inside 1..pageCount after rows were filtered or deleted. */
export const clampPage = (page: number, total: number, size: number) => Math.min(Math.max(1, Math.floor(page) || 1), pageCount(total, size));

/** The rows on one page. */
export function pageSlice<T>(rows: readonly T[], page: number, size: number): T[] {
  const p = clampPage(page, rows.length, size);
  return rows.slice((p - 1) * size, p * size);
}

/**
 * Page buttons to show: all of them up to seven pages, otherwise the first, the last and the current page with its
 * neighbours, with '…' for each skipped run (a gap of exactly one page shows that page instead of '…').
 */
export function pageList(page: number, pages: number): (number | '…')[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const shown = [...new Set([1, 2, page - 1, page, page + 1, pages - 1, pages])].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const out: (number | '…')[] = [];
  shown.forEach((n, i) => {
    const prev = shown[i - 1];
    if (prev !== undefined && n - prev === 2) out.push(n - 1);
    else if (prev !== undefined && n - prev > 2) out.push('…');
    out.push(n);
  });
  return out;
}
