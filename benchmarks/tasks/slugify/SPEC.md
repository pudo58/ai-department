# Slugify — turn text into a URL-safe slug

Implement `src/slugify.js` exporting `slugify(input, { maxLength = 80, separator = '-' } = {})`, a pure function that returns a string.

1. `input` must be a string, `maxLength` a positive safe integer and `separator` either `'-'` or `'_'`. Otherwise `slugify` throws an `Error` whose `code` is `INVALID_INPUT`.
2. The text is first normalized with Unicode NFKD, every combining mark (Unicode category `Mn`) is removed, and the result is lower-cased. So `é` becomes `e`, and `Å` becomes `a`.
3. A character is kept only if it is an ASCII letter or digit. Every maximal run of other characters (spaces, punctuation, symbols, and any non-ASCII character that did not decompose into ASCII, such as `đ` or `ß`) becomes exactly one `separator`.
4. Separators at the very start and at the very end are removed.
5. If the result is longer than `maxLength`, it is cut to its first `maxLength` characters, and then any separator left at the end is removed. The cut does not look for word boundaries.
6. If nothing is left, the result is the empty string.
7. Digits are kept as they are. The function never returns two separators in a row.

Keep the source compact, use the public API in tests, and do not add behavior beyond this contract.
