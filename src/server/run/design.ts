import type { DesignInputReceipt, DesignReportFacts } from '../../shared/design.js';
import type { Role, Run } from '../../shared/types.js';

/** What an agent turn is given about the design, and how it is checked afterwards. */
export interface AttemptDesign {
  /** Text appended to the prompt: a summary and an index, with a pointer to the files. */
  block: string;
  receipt: DesignInputReceipt;
  /** Where the runtime makes the files readable. */
  exec: { hostDir: string; mountPath: string };
  /** Throws when the folder the agent could read no longer matches what it was given. */
  verifyAfter(): void;
}

/**
 * The part of the design integration a run needs. The orchestrator knows only this, so a run without a design source never touches
 * the Figma code at all.
 */
export interface DesignProvider {
  /** Reasons the design this run is bound to cannot be used now; empty when there is none or it is fine. */
  problems(run: Run): string[];
  prepare(run: Run, role: Role, attemptId: string): Promise<AttemptDesign | undefined>;
  /** For the acceptance report. */
  describe?(run: Run, receipts: readonly { role: string; attemptId: string }[], changedByAgent: number): DesignReportFacts | undefined;
}
