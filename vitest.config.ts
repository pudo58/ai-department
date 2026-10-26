import { defineConfig } from 'vitest/config';
// Many suites start real Git, Vitest and Node child processes; unbounded workers make them fail spuriously when RAM is short.
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], testTimeout: 15000, maxWorkers: 4, env: { AIDEPT_MIN_FREE_MB: '0', AIDEPT_AUTO_TEST_REPAIR: '0' } } });
