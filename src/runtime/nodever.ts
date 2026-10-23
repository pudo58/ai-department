import { parseNodeVersion, type NodeVersion } from '../core/nodever.js';
import { executeFile } from './process.js';

let cached: Promise<NodeVersion | undefined> | undefined;

/**
 * The `node` that checks get when their command starts with `node` (the one on PATH). It is not necessarily the Node
 * running AI Department, so ask it. AIDEPT_PATH_NODE_VERSION overrides the probe for tests and odd setups.
 */
export function hostNodeVersion(): Promise<NodeVersion | undefined> {
  const forced = process.env.AIDEPT_PATH_NODE_VERSION;
  if (forced) return Promise.resolve(parseNodeVersion(forced));
  cached ??= executeFile('node', ['--version'], { timeoutMs: 10_000 }).then((r) => parseNodeVersion(r.stdout), () => undefined);
  return cached;
}
