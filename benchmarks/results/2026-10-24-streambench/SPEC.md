# StreamFold — exact task contract

Implement a durable, multi-tenant event-time aggregation engine in `src/stream.js` (Node 24 ESM, no new dependencies). The public entry point is:

```js
export async function openStream({ store, windowSize, allowedLateness, partitionIds })
```

`store` implements `async load() -> {version, state}` and `async compareAndSwap(version, nextState) -> boolean`. The provided adapter is atomic, asynchronous, and may return `false` because another instance committed. Persist all engine state only through this interface. Do not access adapter internals. Public methods are `ingest(input)`, `advanceWatermark(input)`, and `query(input)`.

## Validation and errors

Throw `Error` with stable `.code`. Codes are `INVALID_INPUT`, `CONFIG_MISMATCH`, `WATERMARK_REGRESSION`, `TOO_LATE`, `IDEMPOTENCY_CONFLICT`, `AGGREGATE_OVERFLOW`, `CONFLICT`, `CORRUPT_STORE`, and `STORAGE_ERROR`.

`windowSize` is a positive safe integer; `allowedLateness` is a nonnegative safe integer; `partitionIds` is a nonempty array of 1–32 distinct valid identifiers. A valid identifier is a string matching `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/`. Validate configuration before touching storage. Reopening a nonempty store requires exactly the same window size, lateness and partition IDs in the same order; otherwise throw `CONFIG_MISMATCH` without writing. `null` store state initializes the engine. Any other malformed or unknown-version state throws `CORRUPT_STORE` and must never be reset or overwritten. Store load/CAS exceptions become `STORAGE_ERROR`. A failed load must not call CAS. A failed CAS must not partially commit.

All method inputs are plain JSON objects with only documented keys. Reject null, arrays, exotic objects, unknown keys, invalid identifiers, unsafe integers, non-finite numbers, and invalid enum-like values with `INVALID_INPUT` before CAS. `tenantId`, `partitionId`, `eventId`, and `key` use the identifier rule. Event `timestamp` is a nonnegative safe integer and `value` is a safe integer (negative values are valid). `partitionId` must be configured. `advanceWatermark.watermark` is a nonnegative safe integer.

## Event ingestion

`await ingest({tenantId, partitionId, eventId, key, timestamp, value})` returns `{status:'accepted'|'duplicate', windowStart, windowEnd, aggregate}`. Windows are half-open tumbling intervals `[n*windowSize,(n+1)*windowSize)`. Use integer-safe arithmetic; overflow in window end or aggregate count/sum is an error and must not commit.

Event identity is `(tenantId,eventId)`, independent of partition. An exact replay of all six event fields returns `duplicate` and changes no state, even after its window closes. Reuse of the same identity with any differing field throws `IDEMPOTENCY_CONFLICT`, also without mutation. Deduplication survives restart and is retained after window closure.

Each tenant has an independent watermark per configured partition, initially zero. Its global watermark is the minimum partition watermark. A window closes when `globalWatermark >= windowEnd + allowedLateness`; equality is closed. A new event for a closed window throws `TOO_LATE`. Accepted events update the aggregate for `(tenantId,key,windowStart)`: `{tenantId,key,windowStart,windowEnd,count,sum,min,max,closed}`. Event order does not affect the result. `closed` is derived from the current tenant global watermark and is reflected by query results.

## Watermarks

`await advanceWatermark({tenantId,partitionId,watermark})` returns `{partitionWatermark,globalWatermark,closedWindows}`. `partitionWatermark` is the stored value; global is the minimum across every configured partition. A lower value throws `WATERMARK_REGRESSION` with no write; an equal value is an idempotent no-op. `closedWindows` is the number of distinct aggregate windows for that tenant that are newly closed by this call (not number of rows/keys). A tenant with no events returns zero. Watermarks are monotonic and tenant-scoped. Advancing one partition must never close a window until every partition has passed its close boundary.

## Queries

`await query({tenantId, key?})` returns `{globalWatermark, partitionWatermarks, aggregates}`. `partitionWatermarks` is a plain object containing every configured partition in configured order. Aggregates include only rows with events, optionally filtered by exact key, and are sorted by `windowStart` ascending then key lexicographically using code-unit order. Each row has exactly the eight documented aggregate fields above. Query is read-only and must not initialize storage, normalize state, or write. It returns detached values; caller mutation cannot affect future results.

## Concurrency and durability

Multiple `openStream` instances may share one store. Every mutating operation must load the latest version and recompute after CAS conflict, up to eight CAS attempts total; if all eight return false, throw `CONFLICT`. Never overwrite newer state or return a result based on an uncommitted attempt. No-op replay/equal watermark performs no CAS. State survives a fresh process/reopen using the same file store. Tenant data, dedupe keys and watermarks never cross tenant boundaries. Keep output JSON-safe and deterministic.

## Scope

Write implementation only in `src/stream.js`; add tests under `tests/**/*.test.js`; documentation may change in `README.md`. Do not modify the store adapter, package/configuration, evaluator, or other scaffold files. Do not add dependencies. Use the provided Vitest command. The store is intentionally opaque. Do not assume private adapter fields. The external evaluator tests the public API and file persistence.
