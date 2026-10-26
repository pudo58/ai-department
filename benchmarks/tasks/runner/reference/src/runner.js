function fail(code, message) {
  const error = new Error(message ?? code);
  error.code = code;
  return error;
}

export function createRunner({ concurrency = 2 } = {}) {
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) throw fail('INVALID_INPUT');
  const queue = [];
  const runningKeys = new Set();
  const idleWaiters = [];
  let running = 0;

  function pump() {
    while (running < concurrency) {
      const index = queue.findIndex((task) => !runningKeys.has(task.key));
      if (index < 0) break;
      const [task] = queue.splice(index, 1);
      start(task);
    }
    if (running === 0 && queue.length === 0) for (const resolve of idleWaiters.splice(0)) resolve();
  }

  function start(task) {
    if (task.signal) task.signal.removeEventListener('abort', task.onAbort);
    running += 1;
    runningKeys.add(task.key);
    const finish = (settle, value) => {
      running -= 1;
      runningKeys.delete(task.key);
      pump();
      settle(value);
    };
    let result;
    try { result = task.fn(); } catch (error) { finish(task.reject, error); return; }
    Promise.resolve(result).then((value) => finish(task.resolve, value), (error) => finish(task.reject, error));
  }

  return {
    run(key, fn, { signal } = {}) {
      return new Promise((resolve, reject) => {
        if (typeof key !== 'string' || key.length === 0 || typeof fn !== 'function') { reject(fail('INVALID_INPUT')); return; }
        if (signal?.aborted) { reject(fail('CANCELLED')); return; }
        const task = { key, fn, resolve, reject, signal };
        if (signal) {
          task.onAbort = () => {
            const index = queue.indexOf(task);
            if (index < 0) return;
            queue.splice(index, 1);
            reject(fail('CANCELLED'));
            pump();
          };
          signal.addEventListener('abort', task.onAbort, { once: true });
        }
        queue.push(task);
        pump();
      });
    },
    drain() {
      return new Promise((resolve) => {
        if (running === 0 && queue.length === 0) resolve();
        else idleWaiters.push(resolve);
      });
    },
    stats: () => ({ running, queued: queue.length }),
  };
}
