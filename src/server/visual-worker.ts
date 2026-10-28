import { parentPort } from 'node:worker_threads';
import { comparePng } from '../core/visual.js';

// PNG decoding/comparison/compression is CPU work: keep it off the API thread so logs and Stop remain responsive.
parentPort!.on('message', ({ id, reference, actual, threshold }) => {
  try { parentPort!.postMessage({ id, result: comparePng(Buffer.from(reference), Buffer.from(actual), threshold) }); }
  catch (error) { parentPort!.postMessage({ id, error: (error as Error).message }); }
});
