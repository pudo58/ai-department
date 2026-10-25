import type { Run, Attempt } from '../shared/types.js';
import type { ExecutionMetrics, ExecutionSpan, RetryReason } from '../shared/execution.js';

/** Union rather than sum: nested steps must never inflate elapsed time. */
export function intervalMs(spans: readonly ExecutionSpan[], now: number): number {
  const intervals = spans.map(s => [Date.parse(s.startedAt), s.endedAt ? Date.parse(s.endedAt) : now])
    .filter(([a,b]) => Number.isFinite(a) && Number.isFinite(b) && b! >= a!).sort((a,b) => a[0]! - b[0]!);
  let total = 0, start:number|undefined, end=0;
  for (const [a,b] of intervals) { if(start===undefined){start=a!;end=b!;}else if(a! > end){ total += end-start; start=a!; end=b!; } else end=Math.max(end,b!); }
  return start===undefined?0:total+end-start;
}
export function executionMetrics(run: Run, attempts: readonly Attempt[], now = Date.now()): ExecutionMetrics {
  const spans = run.executionSpans ?? [];
  const automatic = spans.filter(s => !['queue','approval'].includes(s.kind));
  const counts = new Map<RetryReason,number>();
  for(const s of spans) if(s.retryReason) counts.set(s.retryReason,(counts.get(s.retryReason)??0)+1);
  return { available: !!run.executionSpans, automaticMs: run.executionSpans ? intervalMs(automatic,now) : null,
    waitingMs: run.executionSpans ? intervalMs(spans.filter(s=>['queue','approval'].includes(s.kind)),now) : null,
    agentQueueMs: run.executionSpans ? intervalMs(spans.filter(s=>s.kind==='agent_queue'),now) : null,
    spans, attemptsByRole: Object.fromEntries([...new Set(attempts.map(a=>a.role))].map(role=>[role,attempts.filter(a=>a.role===role).length])),
    retries:[...counts].map(([reason,count])=>({reason,count})) };
}
