# LeaseGrid benchmark — GPT-6 Luna

## Result

Both implementations handled the central queue behaviors well on the independent evaluator. AI Department passed all 52 cases. Single passed 50 of 52 as scored; its only two failures are an unresolved representation detail (`lease: null` versus an omitted `lease` property), which the specification does not settle. On the 50 unambiguous cases, Single passed 50/50. This one run does not establish general superiority.

| Measure | AI Department Verify | Single |
|---|---:|---:|
| Model and effort | GPT-6 Luna, medium for all configured roles | GPT-6 Luna, medium |
| Independent evaluator | 52/52 (10/10) | 50/52 raw (9.62/10); 50/50 unambiguous |
| AI Department check | 19 passed, 1 failed | 10 passed, 0 failed |
| App run status | Failed at check | Blocked by unverified requirement evidence |
| Agent calls | 4: Planner, Author plan, Author tests, Developer | 2: Planner, Developer |
| Active model time | 4m 03s | 2m 07s |
| App cost estimate | $0.79 | $0.46 |
| Mutation / Verifier | Not reached | Not run in Single mode |

The app cost is an estimate, not a cash charge; both runs used the connected subscription. The Single run’s wall time was about 6m 27s because the app serializes execution and it waited behind Department. Active model time is the fairer timing comparison here.

## What happened

Department planned 20 risk cases and generated a manifest and an acceptance test file. Its check found 19 tests passing and one failing. The failing test `C-19` claimed two ready jobs, had two concurrent claims consume both, then expected another claim after reopening to return a third job. No third job had been enqueued, so the test dereferenced `undefined`. The failure is in the Author-generated test, not in the queue behavior; the independent evaluator’s concurrent-claim and fencing cases passed. Because the app check failed, the run stopped before mutation and Verifier.

Single’s app check passed 10/10, but its acceptance matrix still lacked evidence for R-5, R-8, R-11, R-13, R-14, R-16, R-17, R-18 and R-19, so the run stopped before acceptance. Its independent evaluator failures were LS01 and LS05: after ack/nack, the evaluator expected `job.lease === undefined`, while Single returned `job.lease === null`. Both mean there is no active lease; the public contract says the lease is cleared but does not specify whether its field is omitted or null. I therefore report the raw score and treat those two cases as inconclusive on behavioral correctness.

Department showed the stronger test-planning path in this run, with 20 planned cases and 19 passing generated tests. Single used fewer calls and less active time, and its generated check passed. Department did not complete its verification stages because of its own test defect; Single did not complete the app’s evidence gate. The run therefore shows a promising Department advantage in structured test design, alongside a real reliability gap in validating its generated tests before relying on them.

## Benchmark controls and limits

Both projects started from the same clean commit and received the same LeaseGrid specification, local Node 24.12.0/Vitest 3.2.4 environment, check command and effective $6 model budget. The evaluator had 52 frozen cases and was not shown to either run. No source or test files were edited by the coordinator. Two written clarifications resolved questions from Department’s test plan; these followed the specification and are recorded in `v3-intervention-receipt.json`. The first draft of this benchmark was excluded after review found an ambiguity around worker IDs and an incorrect retry-timing assertion; this final pair used the corrected contract and evaluator.

No delivery or app acceptance was performed. These results measure one synthetic implementation task, not long-term defect rates or the amount of manual testing saved on real projects.

## Evidence files

- Protocol and hashes: `protocol.json`
- Department app detail and frozen evaluator output: `v3-department-detail.json`, `v3-department-grade.json`
- Single app detail and frozen evaluator output: `v3-single-detail.json`, `v3-single-grade.json`
- Benchmark project copies: `C:/Users/ADMIN/OneDrive/Desktop/ai-department-leasegrid-20261024-v3/department` and `/single`
- Excluded pilot notes and snapshots: files named `*-pilot-*` in this directory
