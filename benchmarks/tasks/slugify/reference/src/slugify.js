function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function slugify(input, { maxLength = 80, separator = '-' } = {}) {
  if (typeof input !== 'string' || !Number.isSafeInteger(maxLength) || maxLength <= 0 || (separator !== '-' && separator !== '_')) throw fail('INVALID_INPUT');
  const folded = input.normalize('NFKD').replace(/\p{Mn}/gu, '').toLowerCase();
  const joined = folded.replace(/[^a-z0-9]+/g, separator);
  const trimEdges = (text) => {
    let start = 0, end = text.length;
    while (start < end && text[start] === separator) start++;
    while (end > start && text[end - 1] === separator) end--;
    return text.slice(start, end);
  };
  const slug = trimEdges(joined);
  if (slug.length <= maxLength) return slug;
  return trimEdges(slug.slice(0, maxLength));
}
