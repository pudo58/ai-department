# StreamFold — high difficulty benchmark

## Task

Implement a durable multi-tenant event-time aggregation engine with tumbling windows, per-partition watermarks, late-event handling, idempotent ingestion, CAS concurrency, state validation, persistence, and deterministic queries. The contract and independent grader are in `SPEC.md` and `grade.mjs`; the final grader SHA-256 is `0f8e7105eaf6bb94c6b9e6fe4f23cdfb5b333943cab4ef703b809b1d2a40ff11`. It has 53 cases. Both candidates started from the same frozen scaffold, Node 24.12.0, Vitest 3.2.4, Stryker 9.6.1, and the same Vitest configuration.

Single used GPT-6 Luna, medium. AI Department Verify was configured with GPT-6 Luna for Planner/Developer and Claude Haiku 5.5 for Author/Verifier, medium; the Verifier did not run. The Department run had a $6 app budget and a 20-minute ceiling. The standalone Codex CLI task had the same 20-minute ceiling; its model/provider subscription does not have an equivalent cash cap, so cost is not compared.

## Result

| Measure | Single | AI Department Verify |
|---|---:|---:|
| External cases | **53/53 (10/10)** | No code candidate produced |
| Candidate self-tests | 4/4 passed | Developer never started |
| Time to final workflow state | **111 seconds** | **596 seconds** |
| AI calls completed | 1 | 3: Planner, Author plan, Author tests |
| Final workflow status | Completed | Blocked before Developer |

The Department planner and both Author calls completed. The Author wrote a test manifest that listed `C-28` as an automated test, although the approved plan marked C-28 as manual. Manifest validation rejected that entry with `Manifest Author không hợp lệ: C-28: ca tự động không tồn tại.` The system correctly prevented an invalid acceptance suite from being locked, but this meant the Developer, checks, mutation and Verifier never ran. The coordinator resolved nine contract questions from the frozen specification and recorded those answers; no source or test code was edited by the coordinator, and no grader result was shown to either agent.

The Department scaffold receives 0/53 if mechanically passed to the grader, but that is **not an implementation score**. Its status is “no deliverable.” The fair conclusion is that Single produced a fully passing implementation in this trial, while Department showed a pre-implementation workflow failure. There is no Department code-quality comparison from this run.

## What the 53 cases cover

Configuration and persisted config mismatch; malformed-state preservation; exact half-open window boundaries; signed aggregation and overflow; duplicate event replay and identity conflicts; independent partition and tenant watermarks; close-boundary and too-late behavior; distinct closed-window counting; stable filtering and ordering; read-only detached queries; CAS retry ceiling and concurrent instances; storage failures; reopen and file persistence.

Single changed only `src/stream.js` and added `tests/stream.test.js`; its own Vitest run passed 4/4. The external grader passed all 53 cases, including persistence and concurrent interleavings. The evaluation did not include model retries or feedback based on hidden grader failures.

## Evaluator corrections

The first draft of the grader contained several false failures. Before finalizing the score, it was corrected to match the written contract: exact replay now uses the original payload; concurrency stays within the eight-attempt CAS ceiling; close-boundary fixtures actually create an aggregate and advance far enough to close the intended windows; configuration mismatch tests reopen a nonempty store; and no-write/error cases compare against the pre-operation snapshot so either permitted eager or lazy initialization remains valid. Each correction is listed in `evaluator-correction.json`; the final hash above is the version used for the reported score. No failing case was disclosed to either model.

The spec listed nine aggregate fields while one sentence mistakenly called them eight. The reviewed contract clarified that all nine enumerated fields are required. This did not change the external grader's behavioral assertions.

## Artifacts

- `SPEC.md`: frozen task contract.
- `protocol.json`: model settings, limits, base commit, and final evaluator hash.
- `grade.mjs`: independent external grader; no AI calls.
- `native-result.json`, `native-capture.json`, `native-grade.json`: Single model identity, timing, self-check and final grade.
- `department-detail.json`, `department-history.jsonl` when captured by the app, `intervention-receipt.json`: Department attempts and coordinator actions.
- Candidate root: `C:/Users/ADMIN/OneDrive/Desktop/ai-department-streamfold-20261024`.
- Department run: `http://127.0.0.1:4310/#/run/run_52a8385f`.

One synthetic task and one repetition do not establish general superiority. This trial does establish a concrete workflow gap: Author manifest validation can block all coding when a manual case is incorrectly emitted as an automated manifest entry.

Department usage was approximately 1,099,741 input tokens (963,379 cached) and 118,165 output tokens across its three completed calls. The app estimates .0534 against the  cap, while Haiku subscription usage is recorded at zero billed cost; do not read this as an equivalent cash-cost comparison.
