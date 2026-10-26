function fail(text) {
  const error = new Error(`Invalid version: ${String(text)}`);
  error.code = 'INVALID_VERSION';
  return error;
}

const NUMBER = '(0|[1-9]\\d*)';
const IDENT = '[0-9A-Za-z-]+';
const PATTERN = new RegExp(`^[vV]?${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-(${IDENT}(?:\\.${IDENT})*))?(?:\\+(${IDENT}(?:\\.${IDENT})*))?$`);

export function parseVersion(text) {
  if (typeof text !== 'string') throw fail(text);
  const match = PATTERN.exec(text);
  if (!match) throw fail(text);
  const prerelease = match[4] ? match[4].split('.') : [];
  if (prerelease.some((id) => /^\d+$/.test(id) && id.length > 1 && id.startsWith('0'))) throw fail(text);
  return {
    major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]),
    prerelease: prerelease.map((id) => (/^\d+$/.test(id) ? Number(id) : id)),
    build: match[5] ? match[5].split('.') : [],
  };
}

function compareIdentifiers(a, b) {
  const aNumber = typeof a === 'number', bNumber = typeof b === 'number';
  if (aNumber && bNumber) return a < b ? -1 : a > b ? 1 : 0;
  if (aNumber) return -1;
  if (bNumber) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePrepared(a, b) {
  for (const key of ['major', 'minor', 'patch']) if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const shared = Math.min(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < shared; i++) {
    const c = compareIdentifiers(a.prerelease[i], b.prerelease[i]);
    if (c !== 0) return c;
  }
  return a.prerelease.length < b.prerelease.length ? -1 : a.prerelease.length > b.prerelease.length ? 1 : 0;
}

export const compareVersions = (a, b) => comparePrepared(parseVersion(a), parseVersion(b));

export function sortVersions(list) {
  return list.map((text, index) => ({ text, index, parsed: parseVersion(text) }))
    .sort((x, y) => comparePrepared(x.parsed, y.parsed) || x.index - y.index).map((entry) => entry.text);
}

export function maxVersion(list) {
  let best = null, bestParsed = null;
  for (const text of list) {
    const parsed = parseVersion(text);
    if (best === null || comparePrepared(parsed, bestParsed) > 0) { best = text; bestParsed = parsed; }
  }
  return best;
}
