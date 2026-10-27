import type { Run } from '../shared/types.js';
import { EVIDENCE_POLICY_V4, type EvidencePolicy } from '../shared/regression.js';

/**
 * The one place that says what a run's quality policy version means. Phases ask this instead of comparing version numbers,
 * so adding a rule is a change here and not a hunt through the pipeline. Older runs keep the behaviour they were created with.
 */
export interface Policy {
  version: number;
  /** Plans carry oracles (v2+). */
  structured: boolean;
  /** Plans carry steps with before/after state and assertion bindings (v3+). */
  reasoning: boolean;
  /** v4: evidence is never manufactured to keep a run moving. */
  strict: boolean;
  /** Author output is checked structurally and gets one correction (v3+). */
  authorRepair: boolean;
  /** An Author diagnosis is judged as written (v3+); the classic decision list is kept for older runs. */
  structuredDiagnosis: boolean;
  /** A plan the Author could not complete is filled in from the contract (legacy, never v4). */
  completePlan: boolean;
  /** A manifest guessed from test titles may stand in for a bad one (v3 only). */
  derivedManifest: boolean;
  /** Quotations and diagnosis labels are rewritten to pass validation (v3 only). */
  groundDiagnosis: boolean;
  /** A valid Author test correction may be applied without a person (legacy; AIDEPT_AUTO_TEST_REPAIR=0 turns it off). */
  autoTestRepair: boolean;
  /** An unconfirmed blocker/major finding stops blocking after one repair round (legacy). */
  lenientFindings: boolean;
  /** Confirmed behavioural findings leave a locked regression test. */
  regression: boolean;
  /** An independent Verifier verdict for the live checkpoint is required before acceptance. */
  verdictRequired: boolean;
  replay: EvidencePolicy['replay'];
}

export function policyOf(run: Pick<Run, 'qualityPolicyVersion' | 'evidencePolicy'>): Policy {
  const version = run.qualityPolicyVersion ?? 0;
  const strict = version >= 4;
  // A v4 run reads its frozen record, so nothing outside the run can change what it was promised.
  const frozen = strict ? run.evidencePolicy ?? EVIDENCE_POLICY_V4 : undefined;
  return {
    version, structured: version >= 2, reasoning: version >= 3, strict,
    authorRepair: version >= 3, structuredDiagnosis: version >= 3,
    completePlan: !strict, derivedManifest: version === 3, groundDiagnosis: version === 3,
    autoTestRepair: strict ? frozen!.autoTestRepair : process.env.AIDEPT_AUTO_TEST_REPAIR !== '0',
    lenientFindings: !strict, regression: strict ? frozen!.regression : false, verdictRequired: strict,
    replay: frozen?.replay ?? EVIDENCE_POLICY_V4.replay,
  };
}

/** Policy for a version number alone, for code that has no run (validators called with explicit flags). */
export const policyForVersion = (version: number | undefined): Policy => policyOf({ qualityPolicyVersion: version as Run['qualityPolicyVersion'] });
