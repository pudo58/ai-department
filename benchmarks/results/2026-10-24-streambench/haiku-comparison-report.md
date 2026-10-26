# StreamFold benchmark — Haiku 5.5 (2026-10-24)

Both arms started from checkpoint `991203e63ccd88be2c4e781e7baf98f12a29599a`, used the same frozen SPEC, Node/Vitest/Stryker setup and a $6 cap. All configured AI roles used Claude Haiku 5.5 (medium).

| Arm | Result | App checks | Frozen evaluator |
|---|---|---:|---:|
| Single | Checkpoint `82237cfddafc2b66637fe9087b1b621a63f3d539`; awaiting app acceptance | 116/116 | 53/53 (10/10) |
| AI Department Verify | Blocked before Developer; no checkpoint | Not run | Not scored |

Department used Haiku for Planner, one test-plan call, and four acceptance-test/manifest calls. The initial test-plan response had invalid risk-group labels and unresolved assumptions. After reusing the previously validated 41-case plan (recorded intervention), the first manifest mismatched C-27; the second mismatched C-21; the third mismatched C-15, C-11, and C-36; and the fourth still mismatched C-4. The plan links were corrected only where each case’s actions explicitly supported the missing requirement. The run remained blocked at `Manifest Author không hợp lệ: C-4: liên kết yêu cầu không khớp kế hoạch.`; no Department implementation was produced. I did not hand-edit candidate source or tests, did not share evaluator output with either model, and did not score the scaffold as a Department result.

Single's Haiku Developer produced the implementation and tests; app runner passed 116/116, and the independent frozen evaluator passed 53/53. Its run is awaiting the app's acceptance step; no delivery was performed.

This comparison therefore shows a workflow reliability result, not a code-quality tie: Single completed and passed this evaluator, while Verify was stopped by manifest validation before coding. It is one synthetic task; it does not establish that Single is generally better. Human plan/contract interventions are documented in `haiku-intervention-receipt.json` and `haiku-single-intervention-receipt.json`.
