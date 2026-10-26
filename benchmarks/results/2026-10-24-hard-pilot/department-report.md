# Báo cáo nghiệm thu: Pilot thực tế: LeaseQueue / Verify Haiku + Luna

**Trạng thái:** Chưa đủ điều kiện nghiệm thu
**Chế độ:** verify · **Checkpoint:** `1b82e75cd3` · **Tạo lúc:** 2026-10-24T03:45:51.519Z

## Yêu cầu gốc

# LeaseQueue — durable multi-tenant work queue

Implement JavaScript ESM module src/queue.js. Export openQueue({store, now = Date.now, leaseMs = 1000, maxAttempts = 3, backoffMs = 100}). Consumers await openQueue and all methods. Methods may be sync or async as long as await works. No additional dependency. Use supplied lib/stores.js for tests/demo, but production queue may only use the injected store contract, not import the adapter or access its internals.

STORE CONTRACT: await store.load() -> {version, state}; version is a nonnegative integer; state=null means brand-new queue. await store.compareAndSwap(expectedVersion, newState) -> boolean. True means state atomically committed and version incremented, false means another writer won, reload and recompute. State is JSON-serializable opaque object owned by the queue. load/CAS can throw (before committing); propagate as Error.code STORAGE_ERROR, preserve previous persisted state, and do not poison future calls. CAS false can be retried at most 8 times per operation; after 8 false results throw Error.code CONFLICT. Never treat false as success or overwrite stale state. store/load return detached snapshots. Do not mutate a snapshot after handing it to CAS.

PUBLIC API:
- enqueue({tenantId,key,payload,priority=0,delayMs=0}) -> Job
- claim({tenantId,workerId}) -> Job or null
- ack({tenantId,jobId,workerId,leaseToken}) -> Job
- fail({tenantId,jobId,workerId,leaseToken,error}) -> Job
- cancel({tenantId,jobId}) -> Job
- list({tenantId}) -> Job[]

Job fields: {id,tenantId,key,payload,priority,status,attempts,createdAt,availableAt,workerId,leaseToken,leaseUntil,lastError}. Status ready|leased|done|dead|cancelled. New job: attempts=0, createdAt=current time, availableAt=current time+delayMs; workerId/leaseToken/leaseUntil/lastError=null. IDs and tokens are nonempty strings; job IDs globally unique in one store, tokens unique for every claim (including reclaims) and never reused. Ordering is NOT based on lexical job IDs.

VALIDATION: options must be a non-null object; store must expose functions load and compareAndSwap; now must be a function; leaseMs and maxAttempts positive safe integers, backoffMs nonnegative safe integer. Every method argument must be a non-null non-array object (reject absent/null/primitive). tenantId/key/workerId/jobId/leaseToken must be strings nonempty after trim; preserve exact bytes, including leading/trailing whitespace. Priority safe integer in [-10,10]; delayMs safe integer >=0; error nonempty string. Invalid input always Error.code INVALID_INPUT, no mutation. Payload must be non-null JSON object/array: recursively only JSON values, finite numbers, no undefined/functions/BigInt/cycles; preserve nested values. Return defensive deep copies. Inputs must not be retained by mutable reference.

TENANT/IDEMPOTENCY: exact pair (tenantId,key), no delimiter/prototype collisions. Same pair with semantically equal JSON payload (object key order irrelevant; array order significant), same priority and same ORIGINAL delayMs returns original job ID and CURRENT state, even done/dead/cancelled. Different payload/priority/delayMs -> IDEMPOTENCY_CONFLICT. Error on storage must not reserve key. Same key in another tenant is independent. All method IDs are tenant-scoped: unknown job or other tenant's job -> NOT_FOUND, reveal no cross-tenant record; list returns only exact tenant.

SCHEDULING: claim only ready jobs with availableAt <= now, choose highest priority, then smallest availableAt, then enqueue commit order. WorkerId alone does not grant ownership of any job. Claim atomically sets leased, attempts+=1, workerId from request, fresh token and leaseUntil=now+leaseMs. At most one active lease per job across concurrent calls or TWO queue objects sharing the same store. Empty/no due jobs -> null. Reopen must reload state from storage; never assume a cached in-memory snapshot is current.

EXPIRATION: before each valid operation on a tenant, lazily normalize expired leases IN THAT TENANT only. now >= leaseUntil expires. If attempts >= maxAttempts -> dead, else ready with availableAt=now (no backoff for worker disappearance). Clear workerId/token/leaseUntil on expiry. Normalization persists atomically with the operation. Other tenants remain untouched. list and idempotent enqueue replay must also normalize. A lost/stale lease cannot ack/fail after expiry or after reassignment. Retrying after expiry may immediately claim the job again, increments attempts and gets a new token.

ACK/FAIL: for leased job, exact matching workerId AND leaseToken required; wrong/stale pair or non-leased state -> STALE_LEASE, do not finish/requeue the job. Repeating ack of done job with the ORIGINAL successful owner/token returns same done job without extra mutation; keep private receipt data for this replay while public done job clears workerId/token/leaseUntil. Wrong pair on done -> STALE_LEASE. ack dead/cancelled/ready -> STALE_LEASE.
Successful ack -> done, clear public lease fields. fail valid lease -> if attempts >= maxAttempts, dead; otherwise ready, availableAt=now+backoffMs*2**(attempts-1). Both clear lease fields and set lastError to supplied error; ack replay rule does not apply to fail.

CANCEL: only ready -> cancelled and idempotent on cancelled. Leased or done -> INVALID_STATE; dead -> INVALID_STATE. Cross tenant/unknown -> NOT_FOUND. Do not remove idempotency history. Expiration is processed first; expired job becoming ready can be cancelled, expired final attempt becoming dead cannot. No operation auto-executes user payload.

PERSISTENCE/FAILURE: all successful state changes and expirations survive reopen. Two openQueue objects on one store cannot duplicate claims, lose enqueues, reuse tokens or overwrite completed jobs. CAS conflicts recompute against latest state; no stale read-modify-write. When load/CAS throws before commit, no uncommitted changes may leak into later list/reopen. After failure future valid operations can succeed. No auto-retry on thrown storage errors. Unknown/non-null garbage store state must fail CORRUPT_STORE rather than silently reset (at least reject primitives/arrays and invalid/missing schema marker). Store state must have schemaVersion:1 as the format marker; other layout is up to you. All reported errors are Error instances with stated code.

PUBLIC ORDER: list sorted by creation/commit order, includes all statuses; no internal receipts are exposed as job fields. now() returns safe nonnegative ms and does not throw in scope; overflow and OS process contention outside this exercise. Provided file store uses atomic replace and one-process locking: test real reopen across process exit, but simultaneous independent OS writer processes are out of scope. The queue must still support shared-store contention between two independent queue objects with asynchronous delayed load/CAS.

ALLOWED CHANGES: src/queue.js, tests/**/*.test.js, README.md. Do not change SPEC.md, package/config/lockfiles, lib/stores.js, server.mjs. Do not spawn subagents, read sibling projects, external grading files or user data. Write real tests on public methods. Vitest 3.2.4 tools are preinstalled. Reporter JSON IDs are tests/FILE.test.js::full test name; tag R-x and C-x when using an approved Department contract. Do not force all methods synchronous. Run node node_modules/vitest/vitest.mjs run --configLoader runner. No additional business assumptions: use the above decisions. Leave unspecified internal IDs/layout flexible.

## Lý do chưa đủ điều kiện

- Check "test" đang fail.
- Yêu cầu chưa được xác minh: R-1.
- C-1: ca bắt buộc thất bại.
- C-2: ca bắt buộc thất bại.
- C-3: ca bắt buộc thất bại.
- C-4: ca bắt buộc thất bại.
- C-5: ca bắt buộc thất bại.
- C-6: ca bắt buộc thất bại.
- C-7: ca bắt buộc thất bại.
- C-8: ca bắt buộc thất bại.
- C-9: ca bắt buộc thất bại.
- C-10: ca bắt buộc thất bại.
- C-11: ca bắt buộc thất bại.
- C-12: ca bắt buộc thất bại.
- C-13: ca bắt buộc thất bại.
- C-14: ca bắt buộc thất bại.
- C-15: ca bắt buộc thất bại.
- C-16: ca bắt buộc thất bại.
- C-17: ca bắt buộc thất bại.
- C-18: ca bắt buộc thất bại.
- C-19: ca bắt buộc thất bại.
- C-20: ca bắt buộc thất bại.
- C-21: ca bắt buộc thất bại.
- C-22: ca bắt buộc thất bại.
- C-23: ca bắt buộc thất bại.

## Cảnh báo

- **Cần đọc:** Mutation: Chưa nhận diện khả năng mutation trên checkpoint này.
- **Cần đọc:** Bản code này chưa có kết luận Verifier.
- Lưu ý: Công cụ phân tích mã (knip, jscpd, dependency-cruiser) chưa chạy: chưa có đánh giá về mã chết, trùng lặp hay vi phạm ranh giới module.

## Yêu cầu và bằng chứng

| Mã | Yêu cầu | Hành vi | Trạng thái | Test chứng minh |
|---|---|---|---|---|
| R-1 | # LeaseQueue — durable multi-tenant work queue

Implement JavaScript ESM module src/queue.js. Export openQueue({store, … | Mong muốn | failed | — |

## Các ca đã khai báo và rủi ro còn lại

| Ca | Bắt buộc | Kết quả | Test chứng minh |
|---|---|---|---|
| C-1 | Có | failed | test: tests/queue.acceptance.test.js::[R-1][C-1] enqueue, claim and ack keep documented fields, lease values and nested payload |
| C-2 | Có | failed | test: tests/queue.acceptance.test.js::[R-1][C-2] claim picks priority, then earliest availableAt, then commit order and skips jobs not yet due |
| C-3 | Có | failed | test: tests/queue.acceptance.test.js::[R-1][C-3] fail applies exponential backoff, dead-letters at maxAttempts and rejects blank errors |
| C-4 | Có | failed | test: tests/queue.acceptance.test.js::[R-1][C-4] idempotent enqueue replays original id and current state, rejects changed parameters, scopes keys per tenant |
| C-5 | Có | failed | test: tests/queue.acceptance.test.js::[R-1][C-5] ack replay with original owner and token returns the done job without CAS; other pairs get STALE_LEASE |
| C-6 | Có | failed | test: tests/queue.acceptance.test.js::[R-1][C-6] invalid options, arguments, identifiers and payloads fail with INVALID_INPUT without any CAS |
| C-7 | Có | failed | test: tests/queue.acceptance.test.js::[R-1][C-7] tenant and key pairs do not collide through delimiters, prototype names or whitespace |
| C-8 | Có | failed | test: tests/queue.acceptance.test.js::[R-1][C-8] lease expires exactly at leaseUntil; ack one millisecond earlier succeeds and stale token fails after expiry |
| C-9 | Có | failed | test: tests/queue.acceptance.test.js::[R-1][C-9] expiry requeues without backoff while attempts remain and dead-letters at maxAttempts |
| C-10 | Có | failed | test: tests/queue.acceptance.test.js::[R-1][C-10] returned jobs and enqueued payloads are defensive deep copies |
| C-11 | Có | failed | test: tests/queue.acceptance.test.js::[R-1][C-11] cross-tenant and unknown job ids return identical NOT_FOUND and never touch the other tenant |
| C-12 | Có | failed | test: tests/queue.acceptance.test.js::[R-1][C-12] lease ownership requires matching workerId and leaseToken |
| C-13 | Có | failed | test: tests/queue.acceptance.test.js::[R-1][C-13] two queues on one delayed store never duplicate claims or tokens and lose no jobs |
| C-14 | Có | failed | test: tests/queue.acceptance.test.js::[R-1][C-14] CAS false reloads and recomputes; eighth false result throws CONFLICT with no commit |
| C-15 | Có | failed | test: tests/queue.acceptance.test.js::[R-1][C-15] interleaved enqueue, claim, ack, cancel and list across two queues keep every committed change |
| C-16 | Có | failed | test: tests/queue.acceptance.test.js::[R-1][C-16] load failure throws STORAGE_ERROR without CAS, keeps state and lets later calls succeed |
| C-17 | Có | failed | test: tests/queue.acceptance.test.js::[R-1][C-17] CAS failure before commit leaves no visible job, does not retry, and key is not reserved |
| C-18 | Có | failed | test: tests/queue.acceptance.test.js::[R-1][C-18] garbage store state fails CORRUPT_STORE without overwrite; null state creates a new queue |
| C-19 | Có | failed | test: tests/queue.acceptance.test.js::[R-1][C-19] status transitions reject invalid ack, fail and cancel; expired jobs normalize before cancel |
| C-20 | Có | failed | test: tests/queue.acceptance.test.js::[R-1][C-20] reassigned job rejects the previous owner and never reuses a token |
| C-21 | Có | failed | test: tests/queue.acceptance.test.js::[R-1][C-21] committed changes survive child process exit and reopen without stale claims or temp leftovers |
| C-22 | Có | failed | test: tests/queue.acceptance.test.js::[R-1][C-22] states passed to CAS are not mutated later and load/list results are detached snapshots |
| C-23 | Có | failed | test: tests/queue.acceptance.test.js::[R-1][C-23] list returns commit order with all five statuses and normalized expired leases, without receipts |

Manifest: 65eff4885a04e9176073823c0a4c93df96809f7a0d1b809f99f249254ecfc211; thời gian check: 9s.

Mutation: unsupported — Chưa nhận diện khả năng mutation trên checkpoint này.

Các ca đã khai báo đạt không chứng minh mọi tình huống nghiệp vụ đều được kiểm tra.

## Thay đổi so với bản gốc

3 file, +1310 −1

- `src/queue.js` (modified) +170 −1
- `tests/queue.acceptance.test.js` (added) +983 −0
- `tests/queue.behavior.test.js` (added) +157 −0

## Kết quả chạy test

- `node node_modules/vitest/vitest.mjs run --configLoader runner --reporter=json --outputFile=.aidept-report.json` → **failed** · 40 pass, 1 fail, 0 bỏ qua · 4s · 2 lần chạy

## Verifier độc lập

_Bản code này chưa có kết luận Verifier._

## Công sức

- Chi phí: ~$0.57 (ước tính) · 3,248,232 token · 4 lượt agent · 13 phút thời gian AI · 0 vòng sửa
- Công của bạn: 0s

## Nhận kết quả

Trạng thái giao: **unconfirmed** (chưa xác nhận giao thành công)
Branch: `aidept/run_82c59831-A` trong `C:\Users\ADMIN\OneDrive\Desktop\ai-department-leasequeue-20261024\department`.

```bash
git -C "C:\Users\ADMIN\OneDrive\Desktop\ai-department-leasequeue-20261024\department" log --oneline HEAD..aidept/run_82c59831-A
git -C "C:\Users\ADMIN\OneDrive\Desktop\ai-department-leasequeue-20261024\department" diff HEAD..aidept/run_82c59831-A
git -C "C:\Users\ADMIN\OneDrive\Desktop\ai-department-leasequeue-20261024\department" merge aidept/run_82c59831-A
```
