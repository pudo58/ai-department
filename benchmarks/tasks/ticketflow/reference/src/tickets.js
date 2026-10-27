const fail = (code) => Object.assign(new Error(code), { code });
const RANK = { low: 0, normal: 1, high: 2, urgent: 3 };
const LEVELS = Object.keys(RANK);
const STATUSES = ['open', 'assigned', 'pending', 'resolved', 'closed', 'merged'];
const natural = (n) => Number.isSafeInteger(n) && n >= 0;
const text = (value) => { if (typeof value !== 'string' || value === '') throw fail('INVALID_INPUT'); };

export function createTickets({ now = () => 0, reopenWindow = 100, maxReopens = 2, escalateAfter = 50 } = {}) {
  if (!natural(reopenWindow) || reopenWindow < 1 || !natural(escalateAfter) || escalateAfter < 1 || !natural(maxReopens)) throw fail('INVALID_INPUT');
  const tickets = new Map();
  const everUsed = new Set();

  // Time moves tickets on their own: apply whatever the clock has made true before anything reads or changes one.
  const settle = (t) => {
    const time = now();
    if (t.status === 'resolved' && time >= t.resolvedAt + reopenWindow) t.status = 'closed';
    const threshold = t.createdAt + escalateAfter;
    if (!t.escalated && time >= threshold && (t.firstAssignedAt === null || t.firstAssignedAt >= threshold)) t.escalated = true;
    return t;
  };
  const find = (id) => { text(id); const t = tickets.get(id); if (!t) throw fail('UNKNOWN_TICKET'); return settle(t); };
  const view = (t) => {
    settle(t);
    const level = t.escalated ? Math.min(RANK[t.priority] + 1, 3) : RANK[t.priority];
    return { id: t.id, subject: t.subject, priority: t.priority, effectivePriority: LEVELS[level], status: t.status, assignee: t.assignee, reopenCount: t.reopenCount, ...(t.mergedInto ? { mergedInto: t.mergedInto } : {}) };
  };
  const move = (t, from, to) => { if (!from.includes(t.status)) throw fail('BAD_STATE'); t.status = to; return view(t); };

  return {
    create({ id, subject, priority = 'normal' } = {}) {
      text(id); text(subject);
      if (!(priority in RANK)) throw fail('INVALID_INPUT');
      if (everUsed.has(id)) throw fail('ID_TAKEN');
      everUsed.add(id);
      const t = { id, subject, priority, status: 'open', assignee: null, reopenCount: 0, createdAt: now(), firstAssignedAt: null, resolvedAt: null, escalated: false, mergedInto: null, seq: tickets.size };
      tickets.set(id, t);
      return view(t);
    },
    assign(id, agent) {
      const t = find(id); text(agent);
      if (!['open', 'assigned', 'pending'].includes(t.status)) throw fail('BAD_STATE');
      t.firstAssignedAt ??= now(); t.assignee = agent; t.status = 'assigned';
      return view(t);
    },
    wait: (id) => move(find(id), ['assigned'], 'pending'),
    customerReply: (id) => move(find(id), ['pending'], 'assigned'),
    resolve(id) {
      const t = find(id);
      if (t.status !== 'assigned') throw fail('BAD_STATE');
      t.status = 'resolved'; t.resolvedAt = now();
      return view(t);
    },
    reopen(id) {
      const t = find(id);
      if (t.status !== 'resolved') throw fail('BAD_STATE');
      if (t.reopenCount >= maxReopens) throw fail('REOPEN_LIMIT');
      t.reopenCount += 1; t.status = 'assigned';
      return view(t);
    },
    close: (id) => move(find(id), ['resolved'], 'closed'),
    merge(sourceId, targetId) {
      const source = find(sourceId), target = find(targetId);
      if (source === target) throw fail('SAME_TICKET');
      const live = ['open', 'assigned', 'pending'];
      if (!live.includes(source.status) || !live.includes(target.status)) throw fail('BAD_STATE');
      source.status = 'merged'; source.mergedInto = target.id;
      if (RANK[source.priority] > RANK[target.priority]) target.priority = source.priority;
      target.escalated = target.escalated || source.escalated;
      return view(target);
    },
    get: (id) => view(find(id)),
    list({ status, assignee } = {}) {
      if (status !== undefined && !STATUSES.includes(status)) throw fail('INVALID_INPUT');
      if (assignee !== undefined && typeof assignee !== 'string') throw fail('INVALID_INPUT');
      return [...tickets.values()].map((t) => ({ t, v: view(t) }))
        .filter(({ v }) => (status === undefined || v.status === status) && (assignee === undefined || v.assignee === assignee))
        .sort((a, b) => RANK[b.v.effectivePriority] - RANK[a.v.effectivePriority] || a.t.seq - b.t.seq).map(({ v }) => v);
    },
  };
}
