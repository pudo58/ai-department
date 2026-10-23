/** Shared vocabulary of the run pipeline: errors, patterns and small types used by more than one stage. */
import type { RunStatus, Slot } from '../../shared/types.js';

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'HttpError'; }
}
/** A stage cannot continue and needs a person; the run parks in `blocked` with this explanation. */
export class Blocked extends Error {}
export class Stopped extends Error {}

/** Checks that compile the code (no report, exit code only): when one of these fails, later test checks are skipped. */
export const BUILD_RECIPES = new Set(['build', 'compile']);
/** The reviewer's prose without its trailing JSON block, capped: this is what a person reads on the acceptance report. */
export const verifierNarrative = (output: string): string => output.replace(/```json[\s\S]*?```/g, '').replace(/\*\*/g, '').trim().slice(0, 3000);
/** Includes the Claude subscription messages ("5-hour limit reached ∙ resets 3pm", "You've hit your weekly limit"). */
export const QUOTA = /quota|rate.?limit|usage limit|limit reached|hit your [\w -]*limit|resource.?exhausted|\b429\b/i;
/** The provider's servers are busy: nothing is wrong with the task, and the same model usually works again minutes later. */
export const CAPACITY = /at capacity|overloaded|\b503\b|server is busy|try a different model/i;
export const FOLLOWUP_DAYS = 7;
export const WAITING: RunStatus[] = ['draft', 'awaiting_approval', 'paused', 'blocked', 'failed', 'awaiting_acceptance', 'completed'];

export interface CandidateRecord { slot: Slot; checkpoint: string | null; success: boolean; problems: string[]; fatal: boolean; changedFiles: string[]; testFiles: string[]; newToolIssues: number; flakyChecks: number; summary: string }
