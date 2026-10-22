export const ANALYSIS_TOOLS = ['knip', 'jscpd', 'dependency-cruiser'] as const;
export type AnalysisTool = typeof ANALYSIS_TOOLS[number];

export interface ToolReport { tool: AnalysisTool; status: 'ok' | 'not_analyzed'; issues: string[]; reason?: string }
export interface ToolDelta { tool: AnalysisTool; status: 'ok' | 'not_analyzed'; newIssues: string[]; resolvedIssues: string[]; reason?: string }

/**
 * Compares base and candidate runs of an analysis tool. A tool that failed or lacks a config is reported
 * as "not analyzed", never as clean. Counts are signals only and do not decide quality on their own.
 */
export function toolDelta(base: ToolReport, candidate: ToolReport): ToolDelta {
  if (base.status !== 'ok' || candidate.status !== 'ok') {
    return { tool: candidate.tool, status: 'not_analyzed', newIssues: [], resolvedIssues: [], reason: candidate.reason ?? base.reason ?? 'Công cụ chưa chạy được.' };
  }
  const before = new Set(base.issues), after = new Set(candidate.issues);
  return {
    tool: candidate.tool, status: 'ok',
    newIssues: candidate.issues.filter((i) => !before.has(i)),
    resolvedIssues: base.issues.filter((i) => !after.has(i)),
  };
}

export const notAnalyzed = (tool: AnalysisTool, reason: string): ToolReport => ({ tool, status: 'not_analyzed', issues: [], reason });
