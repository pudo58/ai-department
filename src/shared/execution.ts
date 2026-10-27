export type RetryReason = 'environment' | 'invalid_output' | 'missing_evidence' | 'test_error' | 'implementation' | 'check_failure' | 'user_request';
export interface ExecutionSpan {
  id: string; kind: 'run' | 'queue' | 'setup' | 'preflight' | 'agent_queue' | 'agent' | 'check' | 'mutation' | 'approval' | 'tool';
  label: string; startedAt: string; endedAt?: string; status: 'running' | 'completed' | 'failed' | 'interrupted';
  attemptId?: string; role?: string; retryReason?: RetryReason;
}
export interface ExecutionMetrics {
  available: boolean; automaticMs: number | null; waitingMs: number | null; agentQueueMs: number | null;
  spans: ExecutionSpan[]; attemptsByRole: Record<string, number>; retries: { reason: RetryReason; count: number }[];
}
export interface EnvironmentProbe {
  schemaVersion: 1; status: 'passed' | 'blocked' | 'unsupported'; runtime: string; workspace: string;
  configHash: string; checkpoint: string | null; startedAt: string; endedAt: string;
  checks: { recipeId: string; runner?: string; status: 'passed' | 'blocked' | 'unsupported'; version?: string; message: string }[];
  limitation: string;
}
export interface AuthorDraft {
  schemaVersion: 1; attemptId: string; checkpoint: string; contractHash: string; contractVersion: number;
  configHash: string; slot: 'A'; output: string; patch: string; paths: string[]; problems: string[];
}
export interface PendingAuthorDraft extends AuthorDraft {
  draftHash: string; artifactId: string; repairAvailable?: boolean;
  /** The Author wrote no test file, so there is nothing to repair; only a change to the contract or the plan can help. */
  empty?: boolean;
}
export interface VerifierScope {
  reviewed: string[]; checkIds: string[]; limitations: string[];
  additionalChecks: { command: string; status: 'passed' | 'failed' | 'incomplete'; detail: string }[];
}
