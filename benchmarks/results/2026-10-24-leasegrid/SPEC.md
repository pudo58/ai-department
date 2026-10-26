# LeaseGrid — durable multi-tenant job queue

Implement `src/queue.js` for Node 24 ESM, with no new dependencies. The queue must preserve state through the supplied opaque storage adapter and remain correct when multiple queue instances share it.

```js
export async function createQueue({store, clock, workerId, leaseMs, maxAttempts, retryDelayMs})
```

`clock` is a function returning a nonnegative safe integer millisecond timestamp. `store` has `load() -> {version, state}` and `compareAndSwap(version, nextState) -> boolean`; it is asynchronous and atomic. It may report conflicts. Never inspect adapter internals. Configuration must be validated before storage is touched. `workerId` is a valid identifier matching `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/`; `leaseMs` and `maxAttempts` are positive safe integers; `retryDelayMs` is a nonnegative safe integer. Persist and compare the queue-wide configuration (`leaseMs`, `maxAttempts`, `retryDelayMs`) on reopen. A mismatch throws `CONFIG_MISMATCH` without a write. `workerId` identifies this queue instance, is not part of the persisted queue-wide configuration, and may differ between instances sharing a store. A lease records the workerId of the instance that claimed it. Null state initializes an empty queue on the first mutation; query operations never initialize or write. Malformed or unsupported stored state throws `CORRUPT_STORE` and is never overwritten.

All public object inputs must be plain JSON objects with only documented keys. Validate fully before writing. Throw `Error` with a stable `.code`. Codes: `INVALID_INPUT`, `CONFIG_MISMATCH`, `CORRUPT_STORE`, `STORAGE_ERROR`, `CONFLICT`, `NOT_FOUND`, `ID_CONFLICT`, `DUPLICATE_CONFLICT`, `NOT_READY`, `STALE_LEASE`, `LEASE_EXPIRED`, `ALREADY_TERMINAL`, `NOT_CANCELLABLE`, `TIME_OVERFLOW`.

## Jobs and enqueue

`enqueue({tenantId,id,payload,priority?,runAt?,dedupeKey?})` accepts valid identifiers for tenant, id and optional dedupe key. `payload` must be a JSON value (null, boolean, finite number, string, array or plain object), deeply detached from caller data; reject cycles, undefined, non-finite numbers, exotic objects, and unsafe integers. `priority` defaults to 0 and is a safe integer. `runAt` defaults to the current clock value and is a nonnegative safe integer. Do not call the clock more than once per public operation.

Job identity is `(tenantId,id)`. Re-enqueueing an existing identity with exactly the same immutable fields (`payload`, `priority`, `runAt`, `dedupeKey`) returns `{status:'duplicate', job}` without a write, regardless of current job state. Any difference throws `ID_CONFLICT`. A dedupe key is unique per tenant across all jobs, including terminal jobs. Reusing it for another id throws `DUPLICATE_CONFLICT` without mutation.

New jobs have `state:'queued'`, `attempt:0`, `createdAt` equal to enqueue time, `availableAt` equal to `runAt`, and no lease. Return `{status:'enqueued', job}`. Returned values are detached copies.

## Claim and ordering

`claim({tenantId})` first applies expiry handling for that tenant, then claims at most one ready job for it. A job is ready when `state` is `queued` or `retry_wait` and `availableAt <= now`. Order ready jobs by priority descending, then `availableAt` ascending, then `createdAt` ascending, then `id` by Unicode code point order. Jobs from another tenant are invisible and cannot affect ordering.

Claiming increments `attempt` and a queue-wide monotonically increasing safe integer `fence`, and creates a lease `{workerId, token:fence, expiresAt:now+leaseMs}`. Return `{status:'claimed',job}`. If none is ready, return `{status:'empty'}`. Claiming an empty queue or processing no expiry performs no write. Overflow of time, attempt or fence throws `TIME_OVERFLOW` and does not commit.

## Lease operations

`ack({tenantId,id,token})` succeeds only for the current, unexpired lease. It moves the job to `succeeded`, clears the lease and returns `{status:'succeeded',job}`. A token for an older lease throws `STALE_LEASE`; a matching token at or after `expiresAt` throws `LEASE_EXPIRED`; an already terminal job throws `ALREADY_TERMINAL`.

`nack({tenantId,id,token,error})` has the same lease checks. `error` is a string of at most 1,000 characters. It records the latest error in `job.lastError` and clears the lease. If `attempt < maxAttempts`, set `state:'retry_wait'`, `availableAt = now + retryDelayMs * 2 ** (attempt - 1)`. Otherwise set `state:'dead'`. Exponential delay arithmetic must be safe; overflow throws `TIME_OVERFLOW` without changing the job. Return `{status:'retry_wait'|'dead',job}`.

`extend({tenantId,id,token})` requires the current unexpired lease and sets `expiresAt = now + leaseMs`, keeping the same fencing token. It returns `{status:'extended',job}`. Time overflow leaves state unchanged.

At the exact expiry time the lease is expired. Before a claim selects work, all expired leases for that tenant are processed in the same atomic operation: jobs below the attempt limit enter `retry_wait` with the same exponential delay measured from the current clock value of this claim (the time expiry is detected); jobs at the limit enter `dead`. The old lease is cleared. This expiry processing must be durable even if no other job is ready. `claim` returns any claimed job from the resulting state, or `empty`. A stale worker can never ack/nack/extend after lease expiry or a later claim.

## Cancel and reads

`cancel({tenantId,id})` cancels jobs in `queued` or `retry_wait`, clears any lease, and returns `{status:'cancelled',job}`. A missing job throws `NOT_FOUND`; a leased job throws `NOT_CANCELLABLE`; terminal jobs throw `ALREADY_TERMINAL`. Cancellation is idempotent only for an already-cancelled job, which returns `{status:'already_cancelled',job}` without a write.

`get({tenantId,id})` returns `{job}` or throws `NOT_FOUND`. `list({tenantId,state?})` returns `{jobs}` sorted by `createdAt` ascending then id, optionally filtered to one of `queued`, `retry_wait`, `leased`, `succeeded`, `dead`, `cancelled`. Reads are detached and never write. Tenants must be isolated in every method and error.

## Concurrency and durability

Every mutation reloads the latest state and recomputes after CAS conflict, with at most eight CAS attempts total. Never return a result derived from an uncommitted attempt. If all eight attempts conflict, throw `CONFLICT`. Operations that are proven no-ops do not call CAS. Storage exceptions become `STORAGE_ERROR`; a failed load never calls CAS and a failed CAS cannot partially commit. Concurrent claims sharing a store must never receive the same fencing token or lease. Fence values never decrease or repeat, including after restart. State and dedupe identity survive reopening with a fresh process against the same file adapter. Preserve unrelated tenant state during each commit.

## Scope

Implement only `src/queue.js`; add useful tests under `tests/**/*.test.js`; README documentation may change. Do not edit the store adapter, package/configuration, frozen evaluator or other scaffold files. No dependencies. Run `node node_modules/vitest/vitest.mjs run --configLoader runner`.
