const TERMINAL = new Set(['done', 'dead', 'cancelled', 'blocked']);
const FAILED = new Set(['dead', 'cancelled', 'blocked']);

function fail(code, message) {
  const error = new Error(message ?? code);
  error.code = code;
  return error;
}
const isId = (v) => typeof v === 'string' && v.length > 0;
const isSafeInt = (v) => Number.isSafeInteger(v);
const isPositive = (v) => Number.isSafeInteger(v) && v > 0;
const isNonNegative = (v) => Number.isSafeInteger(v) && v >= 0;
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

function build(state) {
  const jobs = new Map(state.jobs.map((j) => [j.id, j]));
  let { now, nextSequence, nextToken } = state;
  const { retryBase, maxAttempts } = state;

  const view = (j) => {
    const out = { id: j.id, dependsOn: [...j.dependsOn], priority: j.priority, sequence: j.sequence, status: j.status, attempt: j.attempt, availableAt: j.availableAt };
    if (j.status === 'blocked') out.blockedBy = j.blockedBy;
    if (j.status === 'leased') { out.worker = j.worker; out.token = j.token; out.leaseUntil = j.leaseUntil; }
    if (j.result !== undefined) out.result = clone(j.result);
    if (j.lastError !== undefined) out.lastError = j.lastError;
    return out;
  };
  const need = (id) => {
    const job = jobs.get(id);
    if (!job) throw fail('UNKNOWN_JOB', `Unknown job ${String(id)}`);
    return job;
  };
  const clearLease = (j) => { delete j.worker; delete j.token; delete j.leaseUntil; };
  const leased = (id, worker, token) => {
    const job = need(id);
    if (job.status !== 'leased' || job.worker !== worker || job.token !== token) throw fail('LEASE_LOST', `Lease lost for ${id}`);
    return job;
  };

  /** Re-evaluates every non-terminal job that waits on others, until nothing changes. */
  function settle() {
    let changed = true;
    while (changed) {
      changed = false;
      for (const j of [...jobs.values()].sort((a, b) => a.sequence - b.sequence)) {
        if (j.status !== 'waiting') continue;
        const deps = j.dependsOn.map((d) => jobs.get(d));
        const bad = j.dependsOn.find((d) => FAILED.has(jobs.get(d).status));
        if (bad !== undefined) { j.status = 'blocked'; j.blockedBy = bad; changed = true; }
        else if (deps.every((d) => d.status === 'done')) { j.status = 'ready'; changed = true; }
      }
    }
  }

  function failJob(j, error) {
    j.lastError = error;
    clearLease(j);
    if (j.attempt < maxAttempts) { j.status = 'ready'; j.availableAt = now + retryBase * 2 ** (j.attempt - 1); }
    else j.status = 'dead';
  }

  return {
    submit(input) {
      if (!input || typeof input !== 'object') throw fail('INVALID_INPUT');
      const { id, dependsOn = [], priority = 0 } = input;
      if (!isId(id)) throw fail('INVALID_INPUT', 'id');
      if (!isSafeInt(priority)) throw fail('INVALID_INPUT', 'priority');
      if (jobs.has(id)) throw fail('JOB_EXISTS', id);
      if (!Array.isArray(dependsOn) || dependsOn.some((d) => !isId(d)) || new Set(dependsOn).size !== dependsOn.length || dependsOn.includes(id)) throw fail('INVALID_DEPENDENCIES');
      if (dependsOn.some((d) => !jobs.has(d))) throw fail('UNKNOWN_DEPENDENCY');
      const job = { id, dependsOn: [...dependsOn], priority, sequence: nextSequence++, status: 'waiting', attempt: 0, availableAt: now };
      jobs.set(id, job);
      settle();
      return view(job);
    },
    get: (id) => view(need(id)),
    claim(input) {
      const { worker, leaseFor } = input ?? {};
      if (!isId(worker) || !isPositive(leaseFor)) throw fail('INVALID_INPUT');
      const candidates = [...jobs.values()].filter((j) => j.status === 'ready' && j.availableAt <= now)
        .sort((a, b) => b.priority - a.priority || a.sequence - b.sequence || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const job = candidates[0];
      if (!job) return null;
      job.attempt += 1;
      job.status = 'leased';
      job.worker = worker;
      job.token = nextToken++;
      job.leaseUntil = now + leaseFor;
      return view(job);
    },
    renew(input) {
      const { id, worker, token, leaseFor } = input ?? {};
      if (!isPositive(leaseFor)) throw fail('INVALID_INPUT');
      const job = leased(id, worker, token);
      job.leaseUntil = Math.max(job.leaseUntil, now + leaseFor);
      return view(job);
    },
    complete(input) {
      const { id, worker, token, result } = input ?? {};
      const job = leased(id, worker, token);
      if (result === undefined) delete job.result; else job.result = clone(result);
      delete job.lastError;
      clearLease(job);
      job.status = 'done';
      settle();
      return view(job);
    },
    fail(input) {
      const { id, worker, token, error } = input ?? {};
      if (!isId(error)) throw fail('INVALID_INPUT', 'error');
      const job = leased(id, worker, token);
      failJob(job, error);
      settle();
      return view(job);
    },
    cancel(id) {
      const job = need(id);
      if (TERMINAL.has(job.status)) throw fail('JOB_TERMINAL', id);
      clearLease(job);
      job.status = 'cancelled';
      settle();
      return view(job);
    },
    advance(time) {
      if (!isNonNegative(time) || time < now) throw fail('INVALID_TIME');
      now = time;
      const due = [...jobs.values()].filter((j) => j.status === 'leased' && j.leaseUntil <= now)
        .sort((a, b) => a.leaseUntil - b.leaseUntil || a.sequence - b.sequence);
      for (const j of due) failJob(j, 'LEASE_EXPIRED');
      settle();
      return { now, expired: due.map((j) => j.id) };
    },
    snapshot() {
      const list = [...jobs.values()].sort((a, b) => a.sequence - b.sequence).map(view);
      return structuredClone({ schemaVersion: 1, now, retryBase, maxAttempts, nextSequence, nextToken, jobs: list });
    },
  };
}

export function createScheduler(options = {}) {
  const { now = 0, retryBase = 2, maxAttempts = 3 } = options ?? {};
  if (!isNonNegative(now) || !isPositive(retryBase) || !isPositive(maxAttempts)) throw fail('INVALID_INPUT');
  return build({ now, retryBase, maxAttempts, nextSequence: 1, nextToken: 1, jobs: [] });
}

export function restoreScheduler(snapshot) {
  const s = structuredClone(snapshot);
  const jobs = s.jobs.map((j) => ({ ...j, dependsOn: [...j.dependsOn] }));
  return build({ now: s.now, retryBase: s.retryBase, maxAttempts: s.maxAttempts, nextSequence: s.nextSequence, nextToken: s.nextToken, jobs });
}
