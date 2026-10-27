import { describe, expect, it, vi } from 'vitest';
import { policyOf } from '../src/core/policy.js';
import { EVIDENCE_POLICY_V4 } from '../src/shared/regression.js';

// The page calls policyOf for every finding it draws (RunPanels). A browser has no `process`, and the page has no error boundary,
// so reading the environment there would blank the whole run page for every run that is not v4 (compare runs, runs made before v4).
describe('policyOf in a browser (no `process`)', () => {
  const inBrowser = <T>(read: () => T): T => {
    vi.stubGlobal('process', undefined);
    try { return read(); } finally { vi.unstubAllGlobals(); }
  };

  it('answers for runs without a policy version, for legacy versions and for v4, without touching the environment', () => {
    const seen = inBrowser(() => ({
      none: policyOf({ qualityPolicyVersion: undefined }),
      v2: policyOf({ qualityPolicyVersion: 2 }),
      v3: policyOf({ qualityPolicyVersion: 3 }),
      v4: policyOf({ qualityPolicyVersion: 4, evidencePolicy: EVIDENCE_POLICY_V4 }),
    }));
    expect(seen.none).toMatchObject({ version: 0, strict: false, autoTestRepair: true });
    expect(seen.v2).toMatchObject({ version: 2, strict: false, structured: true });
    expect(seen.v3).toMatchObject({ version: 3, strict: false, reasoning: true, autoTestRepair: true });
    expect(seen.v4).toMatchObject({ version: 4, strict: true, autoTestRepair: false });
  });

  it('still honours AIDEPT_AUTO_TEST_REPAIR=0 where there is an environment (the server)', () => {
    const saved = process.env.AIDEPT_AUTO_TEST_REPAIR;
    try {
      process.env.AIDEPT_AUTO_TEST_REPAIR = '0';
      expect(policyOf({ qualityPolicyVersion: 3 }).autoTestRepair).toBe(false);
      process.env.AIDEPT_AUTO_TEST_REPAIR = '1';
      expect(policyOf({ qualityPolicyVersion: 3 }).autoTestRepair).toBe(true);
    } finally { if (saved === undefined) delete process.env.AIDEPT_AUTO_TEST_REPAIR; else process.env.AIDEPT_AUTO_TEST_REPAIR = saved; }
  });
});
