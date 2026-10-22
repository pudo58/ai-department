import { lineSplitter } from './process.js';
import type { RuntimeEvent } from './types.js';

type Sink = ((event: RuntimeEvent) => void) | undefined;

/**
 * ProcessOptions fragment that forwards a child's stdout and stderr, line by line, as `{type:'log'}` events.
 * stderr is reported as a warning only for the source's own label, since many tools write progress there.
 */
export function streamTo(sink: Sink, source: string): { onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void } {
  if (!sink) return {};
  const out = lineSplitter((line) => sink({ type: 'log', message: line, data: { source, level: 'info' } }));
  const err = lineSplitter((line) => sink({ type: 'log', message: line, data: { source, level: 'warn' } }));
  return { onStdout: out.push, onStderr: err.push };
}

/** Agent stdout is parsed as JSONL elsewhere; only stderr becomes console lines here. */
export function streamStderr(sink: Sink): { onStderr?: (chunk: string) => void } {
  if (!sink) return {};
  const err = lineSplitter((line) => sink({ type: 'log', message: line, data: { source: 'agent-stderr', level: 'warn' } }));
  return { onStderr: err.push };
}
