import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Explicit allowlist: this command must never grow to include live-provider or Docker E2E suites implicitly.
const reliabilityTests = [
  // v4 evidence policy and the counterexample → regression loop.
  'tests/policy-v4.test.ts', 'tests/regression-loop.test.ts', 'tests/regression-edges.test.ts', 'tests/regression-hardening.test.ts', 'tests/regression-ui.test.ts', 'tests/eval-v4.test.ts',
  // Fallbacks, plan normalization, hardening and the evaluation pilot.
  'tests/nodeadend.test.ts', 'tests/planfix.test.ts', 'tests/hardening.test.ts', 'tests/pilot.test.ts',
  'tests/author-manifest-repair.test.ts',
  'tests/reasoning.test.ts', 'tests/diagnosis-v3.test.ts', 'tests/reproduction.test.ts', 'tests/reasoning-ui.test.ts',
  'tests/testplan-repair.test.ts',
  'tests/author-resilience.test.ts',
  'tests/execution-speed.test.ts', 'tests/execution-speed-ui.test.ts',
  'tests/author-draft-local.test.ts',
  'tests/monitor-live-ui.test.ts',
  'tests/reliability-v2.test.ts', 'tests/assertion-local.test.ts', 'tests/assertion-ui.test.ts',
  'tests/recovery.test.ts', 'tests/recovery-ui.test.ts', 'tests/recovery-workspace.test.ts', 'tests/recovery-local.test.ts',
  'tests/quality.test.ts', 'tests/quality-orchestrator.test.ts', 'tests/quality-ui.test.ts', 'tests/mutation.test.ts',
  'tests/core.test.ts', 'tests/api.test.ts', 'tests/orchestrator.test.ts', 'tests/contract-review.test.ts',
  'tests/delivery.test.ts', 'tests/delivery-workspace.test.ts', 'tests/verdict-version.test.ts',
  'tests/local.test.ts', 'tests/nogit.test.ts', 'tests/report.test.ts', 'tests/monitor-upgrade.test.ts',
  'tests/preview.test.ts', 'tests/runtime.test.ts',
];
const root = fileURLToPath(new URL('../', import.meta.url));
const output = fileURLToPath(new URL('../test-results/reliability/', import.meta.url));
mkdirSync(output, { recursive: true });
const child = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)), 'run', ...reliabilityTests,
  // Runner fixtures spawn their own workers; keep outer contention below their fixed deadlines.
  '--maxWorkers=2', '--reporter=default', '--reporter=json', '--reporter=junit',
  `--outputFile.json=${output}results.json`, `--outputFile.junit=${output}junit.xml`, ...process.argv.slice(2),
], { cwd: root, stdio: 'inherit', windowsHide: true, env: { ...process.env, AIDEPT_LIVE_E2E: '0', AIDEPT_DOCKER_E2E: '0' } });
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
