function fail(message) {
  const error = new Error(message);
  error.code = 'INVALID_RANGE';
  return error;
}

function checkRange(range) {
  if (!Array.isArray(range) || range.length !== 2 || !Number.isSafeInteger(range[0]) || !Number.isSafeInteger(range[1]) || range[0] > range[1]) throw fail('range');
}
function checkList(list) {
  if (!Array.isArray(list)) throw fail('list');
  for (const range of list) checkRange(range);
}

export function mergeRanges(list) {
  checkList(list);
  const sorted = list.map(([start, end]) => [start, end]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

export function totalLength(list) {
  return mergeRanges(list).reduce((sum, [start, end]) => sum + (end - start + 1), 0);
}

export function contains(list, n) {
  checkList(list);
  if (!Number.isSafeInteger(n)) throw fail('n');
  return list.some(([start, end]) => start <= n && n <= end);
}

export function gaps(list, bounds) {
  checkList(list);
  checkRange(bounds);
  const [from, to] = bounds;
  const out = [];
  let cursor = from;
  for (const [start, end] of mergeRanges(list)) {
    if (end < from) continue;
    if (start > to) break;
    if (start > cursor) out.push([cursor, start - 1]);
    cursor = Math.max(cursor, end + 1);
    if (cursor > to) break;
  }
  if (cursor <= to) out.push([cursor, to]);
  return out;
}
