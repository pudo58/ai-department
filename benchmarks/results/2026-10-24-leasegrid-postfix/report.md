# LeaseGrid benchmark — stateful-plan postfix (2026-10-24)

## Result

Both candidates passed the same frozen external evaluator: **52/52 cases (10/10)**. The evaluator and specification hashes match the benchmark protocol. This means the benchmark does not show a functional score advantage for either approach on its 52 public cases.

| Measure | AI Department — GPT-6 Luna | Single agent — GPT-6 Luna |
|---|---:|---:|
| External evaluator | 52/52 (10/10) | 52/52 (10/10) |
| Product run state | Blocked at Verify after repair | Awaiting user acceptance; checks pass |
| Internal required cases before Verifier | 18/18 passed | Deep-plan policy not enabled |
| Mutation before repair | Baseline passed; 565 killed, 153 survived, 34 no coverage, 3 timed out | Not run |
| Estimated run cost | $1.290 | $0.830 |
| Recorded human interaction actions | 7 | 1 |

The Department's first implementation checkpoint passed its configured test check and all 18 required automated cases. Mutation also completed. Verifier reported one major finding about a storage `load()` exception during `createQueue`, alongside two minor findings. After human review, the major finding was confirmed and the product repair workflow was triggered. The repair changed the initial `load()` catch from swallowing the exception to throwing `STORAGE_ERROR`; the generated acceptance test then failed because it awaits `createQueue()` successfully before testing the later `enqueue()` failure.

That test hardcodes *when* the storage error must surface. The written contract says storage exceptions produce `STORAGE_ERROR` and a failed load must not call CAS; it does not say the error must be deferred until a subsequent queue operation. The final Department code surfaces the error during `createQueue`, which is a defensible reading. The external 52-case evaluator passes that checkpoint. So the observed block is a useful warning about test-oracle precision and Verifier adjudication, rather than proof that the final implementation violates the stated contract. It still counts as a real workflow failure: the run was not accepted, and the generated suite could not validate the repair.

## What changed in this iteration

The stateful-plan work added explicit ordered actions and invariants for required state, concurrency, and consistency cases. On this run, Department planned 19 cases, including 15 required automated cases with sequences and invariants, plus one manual case. All 18 required automated tests passed before the Verifier finding. This is evidence that the new plan can drive broad runnable tests on this fixture; it is not evidence that all edge cases are covered.

## Assessment

For this task, the quality scores tie. Single used fewer model calls and less estimated spend, and reached the acceptance gate with checks passing. Department provided richer pre-implementation plans, per-case evidence, and mutation results, but required more human interaction and ended blocked because its test/review loop disagreed about an unspecified timing detail. The best demonstrated gain is diagnostic depth; an end-to-end quality advantage is not established by one synthetic benchmark.

Recommended next refinement: have the contract/test-plan review label assertions about error timing as *specified*, *inferred*, or *open*. Do not make an inferred timing detail a required blocker unless the user accepts that interpretation. When Verifier proposes a finding, check it against the public contract and an independent observable test before confirming it. For this example, test that the public API eventually returns `STORAGE_ERROR` and never calls CAS, while allowing the error to surface at the initial load or the first operation that performs a load unless the spec is tightened.

## Reproduce

From the repository root, run:

```powershell
node test-results/2026-10-24-leasegrid-postfix/grade.mjs .data/leasegrid-postfix/workspaces/run_d90095df-A test-results/2026-10-24-leasegrid-postfix/department-grade.json
node test-results/2026-10-24-leasegrid-postfix/grade.mjs .data/leasegrid-postfix/workspaces/run_9079fff6-A test-results/2026-10-24-leasegrid-postfix/single-grade.json
```

The test/build regression for the AI Department source had already passed before benchmark execution: build succeeded and `pnpm test:reliability` passed 21 files / 309 tests. GitHub CI was not run as part of this local benchmark.
