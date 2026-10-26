# Ranges — merge and query closed integer ranges

Implement `src/ranges.js` exporting `mergeRanges(list)`, `totalLength(list)`, `contains(list, n)` and `gaps(list, bounds)`. All are pure functions.

1. A range is an array `[start, end]` of two safe integers with `start <= end`. It is closed: it contains `start`, `end` and every integer between them. A list is an array of ranges. Any other shape (a non-array list, a range that is not a pair of safe integers, or `start > end`) makes the function throw an `Error` whose `code` is `INVALID_RANGE`.
2. `mergeRanges(list)` returns a new list in which ranges that overlap or are adjacent are combined into one. Two ranges are adjacent when one starts exactly one integer after the other ends (`[1, 3]` and `[4, 6]` merge into `[1, 6]`; `[1, 3]` and `[5, 6]` do not merge). The result is sorted by `start` ascending and contains no two ranges that could still be merged. The input list and its ranges are not changed, and the returned ranges are new arrays. An empty list gives an empty list.
3. `totalLength(list)` returns the number of distinct integers covered by the ranges in the list. Overlapping ranges count each integer once; `[5, 5]` has length 1. An empty list gives 0.
4. `contains(list, n)` returns `true` when the integer `n` lies in any range of the list, else `false`. `n` must be a safe integer, otherwise it throws `INVALID_RANGE`.
5. `gaps(list, [from, to])` returns the sorted list of maximal closed ranges of integers inside `[from, to]` that are not covered by any range of `list`. `[from, to]` is itself a range under rule 1. Parts of the list outside `[from, to]` are ignored. If everything is covered, the result is an empty list; if nothing is covered, it is `[[from, to]]`.

Keep the source compact, use the public API in tests, and do not add behavior beyond this contract.
