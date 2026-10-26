# QuotaVault — concise task contract

Implement src/quota.js as a durable quota-reservation engine for Node 24 ESM. Add Vitest tests under tests/ and brief usage notes in README.md. Do not add dependencies or change the adapter/configuration.

Public API:
- openVault({store, clock, windowMs, globalLimit, tenantLimits, reservationTtlMs})
- vault.reserve({tenantId, key, units})
- vault.commit({tenantId, key, actualUnits})
- vault.cancel({tenantId, key})
- vault.sweep({})
- vault.usage({tenantId})

The store exposes only async load() -> {version,state} and compareAndSwap(version,nextState) -> boolean. CAS is atomic, may return false under contention, and can throw. Never inspect adapter internals.

## Configuration and validation
Throw Error with stable code. Codes: INVALID_INPUT, CONFIG_MISMATCH, CORRUPT_STORE, STORAGE_ERROR, CAPACITY_EXCEEDED, NOT_FOUND, IDEMPOTENCY_CONFLICT, RESERVATION_EXPIRED, ALREADY_TERMINAL, TIME_OVERFLOW, CONFLICT.

Validate the entire configuration before touching storage. windowMs, globalLimit, reservationTtlMs and every tenant limit are positive safe integers. tenantLimits is a nonempty plain object keyed by valid identifiers. Identifiers match /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/. tenantId and key use the same rule; key is unique per tenant within the current window. units and actualUnits are positive safe integers. Method inputs must be plain JSON objects with only documented keys. Invalid calls do not call CAS.

Persist configuration. Reopening non-null state with different windowMs, globalLimit, reservationTtlMs or tenant limit mapping throws CONFIG_MISMATCH without a write. Tenant mapping equality ignores object key order. Null state is an empty vault. Malformed or unsupported stored state throws CORRUPT_STORE and is never overwritten. Load/CAS exceptions become STORAGE_ERROR. Failed loads never call CAS.

## Windows and accounting
Time is a nonnegative safe integer from clock. Each operation calls clock at most once. The active fixed window is [n*windowMs,(n+1)*windowMs), where n=floor(now/windowMs); calculate boundaries without unsafe arithmetic. A window changes exactly at its end. Prior-window usage and reservations do not count in the new window. Idempotency keys are scoped to tenant plus window, so the same key may be reused in a later window.

Global usage is committed units plus active reserved units across all tenants. Tenant usage is the same sum for that tenant. A reservation is active only before expiresAt; at expiresAt it is expired. The active window has its own accounting; no reservation from an older window consumes capacity.

## Reserve
reserve({tenantId,key,units}) accepts only configured tenants. It returns one of:
- {status:'reserved', reservation, usage}
- {status:'duplicate', reservation, usage}
- {status:'denied', reason:'TENANT_LIMIT'|'GLOBAL_LIMIT', usage}

A pending reservation has exactly {tenantId,key,units,windowStart,expiresAt,state}. expiresAt is now+reservationTtlMs; overflow throws TIME_OVERFLOW without a write. New reservations use state pending. A committed reservation also exposes actualUnits. Check tenant capacity first, then global capacity. A denied request writes nothing and does not reserve its key. Same tenant/key in the same window with the same units returns duplicate and the existing reservation; different units throws IDEMPOTENCY_CONFLICT. Replays of committed or cancelled reservations also return duplicate and never reopen them. Expired pending reservations do not block capacity; reserve and sweep may persist their transition to expired. Returned objects are detached.

## Commit and cancel
commit({tenantId,key,actualUnits}) changes a pending, unexpired reservation in the current window to committed and records actualUnits; actualUnits may be from 1 through reserved units. Unused reserved capacity is released. Return {status:'committed',reservation,usage}. Repeating commit with the same actualUnits returns {status:'duplicate',reservation,usage}; a different amount throws IDEMPOTENCY_CONFLICT. Unknown reservation throws NOT_FOUND. A pending reservation that is expired or belongs to an older window throws RESERVATION_EXPIRED and is not committed. A cancelled or expired reservation cannot be committed and throws ALREADY_TERMINAL.

cancel({tenantId,key}) changes a pending, unexpired reservation in the current window to cancelled and releases its full reservation. Return {status:'cancelled',reservation,usage}. Repeating cancel after cancellation returns {status:'duplicate',reservation,usage}. Unknown reservation throws NOT_FOUND. A committed reservation throws ALREADY_TERMINAL. Expired or prior-window pending reservations throw RESERVATION_EXPIRED.

## Expiry and usage
sweep({}) expires every pending reservation whose deadline is at or before now or whose window is no longer active. Return {expiredCount,windowStart}. It is a no-op without CAS when nothing expires. Expiry is terminal; the same key cannot be reserved again in the same window.

usage({tenantId}) is read-only and returns {windowStart,globalUsed,globalReserved,tenantUsed,tenantReserved,globalLimit,tenantLimit}. Used counts committed actualUnits; reserved counts active pending units. Expired and prior-window reservations are excluded even before sweep. Missing tenant config throws INVALID_INPUT. Reads do not initialize state or CAS. Query output is detached.

## Atomicity and durability
Every mutation reads the latest version, recomputes after CAS false, and makes at most eight CAS attempts. Exhaustion throws CONFLICT. Never return a result from an uncommitted attempt. Concurrent reservations must not overbook either limit. A no-op duplicate or empty sweep performs no CAS. State survives reopening with the same adapter. Tenant accounting and idempotency never leak between tenants. On any error, no partial state change is visible.

## Scope
Keep the implementation in src/quota.js, tests in tests/**/*.test.js, and brief docs in README.md. Do not read or modify evaluator files, sibling workspaces, or the adapter. No new dependencies. Resolve unspecified behavior without inventing public guarantees; document any material assumption.

