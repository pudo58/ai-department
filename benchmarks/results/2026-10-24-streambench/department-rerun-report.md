# StreamFold benchmark — AI Department guided rerun

- Run: `run_29ebcc23`; project: `prj_5121b782`; workspace: `C:\Users\ADMIN\OneDrive\Desktop\ai-department-streamfold-20261024\department-rerun`
- Protocol: iteration 2, guided after the first run blocked because C-28 (manual in that plan) was incorrectly included in the automated manifest. The rerun then exposed a separate schema mismatch: Author returned question objects instead of the required string array. We clarified questions from the frozen SPEC and added output-format guidance; therefore this is not a fully independent blind repetition.
- Models: Planner/Developer GPT-6 Luna; Author/Verifier Claude Haiku 5.5.
- Contract: v4, 41 required test cases. Author tests were locked before Developer.
- Outcome: Department evaluator score **53/53 (10/10)**; AI Department status **blocked** because one confirmed major Verifier finding remains unresolved. The independent single-agent candidate also scored **53/53 (10/10)** on the same frozen grader.
- Internal test evidence: **41/41 declared cases passed**; required Vitest check passed.
- Mutation: 410 killed, 105 survived, 12 no coverage, 1 timeout, 0 errors; baseline passed.
- Confirmed major finding: concurrent `openStream` calls against one null store can make one caller reject with `CONFLICT` after the other initializes it. The repair patch fixed source logic but also modified locked `tests/store-state-contract.test.js`; scope enforcement rejected and reverted the whole patch. Checkpoint remains unchanged at `4fcb5d8cfbb3daa483c965975ff8f639c3ded5ce`.
- Other open minor findings: null-store reset/dedupe ambiguity, adapter parse-error classification, duplicated test helpers, and a false-positive C-28 guidance interpretation.
- No evaluator result was sent to either model. The benchmark grader remains outside both candidate workspaces.
