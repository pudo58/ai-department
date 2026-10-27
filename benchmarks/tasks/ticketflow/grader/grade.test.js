// Hidden grader for TicketFlow. It asserts only what SPEC.md decides.
import { describe, expect, it } from 'vitest';
import { createTickets } from '../src/tickets.js';

const code = async (fn) => { try { await fn(); } catch (error) { return error?.code ?? `NO_CODE:${error?.message}`; } return 'NO_ERROR'; };
const clock = (start = 0) => { const c = { t: start, now: () => c.t }; return c; };
const make = (config = {}, start = 0) => { const c = clock(start); return { s: createTickets({ now: c.now, ...config }), c }; };
const status = async (s, id) => (await s.get(id)).status;

describe('validation and creation', () => {
  it('rejects invalid options with INVALID_INPUT', async () => {
    for (const options of [{ reopenWindow: 0 }, { reopenWindow: 1.5 }, { escalateAfter: 0 }, { escalateAfter: -3 }, { maxReopens: -1 }, { maxReopens: 1.5 }]) {
      expect(await code(() => createTickets(options)), JSON.stringify(options)).toBe('INVALID_INPUT');
    }
    expect(typeof createTickets({ maxReopens: 0 }).create).toBe('function');
  });
  it('creates an open, unassigned ticket with the specified view', async () => {
    const { s } = make();
    const t = await s.create({ id: 'T1', subject: 'Printer on fire' });
    expect(t).toEqual({ id: 'T1', subject: 'Printer on fire', priority: 'normal', effectivePriority: 'normal', status: 'open', assignee: null, reopenCount: 0 });
    expect((await s.create({ id: 'T2', subject: 'x', priority: 'urgent' })).priority).toBe('urgent');
    expect(await s.get('T1')).toEqual(t);
  });
  it('rejects bad input, taken ids and unknown tickets with the specified codes', async () => {
    const { s } = make();
    for (const input of [{ id: '', subject: 's' }, { id: 'a', subject: '' }, { id: 5, subject: 's' }, { id: 'a', subject: 's', priority: 'medium' }, { id: 'a' }]) {
      expect(await code(() => s.create(input)), JSON.stringify(input)).toBe('INVALID_INPUT');
    }
    await s.create({ id: 'a', subject: 's' });
    expect(await code(() => s.create({ id: 'a', subject: 'again' }))).toBe('ID_TAKEN');
    for (const call of [() => s.get('zz'), () => s.assign('zz', 'ann'), () => s.wait('zz'), () => s.customerReply('zz'), () => s.resolve('zz'), () => s.reopen('zz'), () => s.close('zz'), () => s.merge('zz', 'a'), () => s.merge('a', 'zz')]) {
      expect(await code(call)).toBe('UNKNOWN_TICKET');
    }
    expect(await code(() => s.assign('a', ''))).toBe('INVALID_INPUT');
    expect(await status(s, 'a')).toBe('open');
  });
});

describe('transitions', () => {
  it('follows open → assigned → pending → assigned → resolved → closed', async () => {
    const { s } = make();
    await s.create({ id: 'a', subject: 's' });
    expect(await s.assign('a', 'ann')).toMatchObject({ status: 'assigned', assignee: 'ann' });
    expect(await s.wait('a')).toMatchObject({ status: 'pending', assignee: 'ann' });
    expect(await s.customerReply('a')).toMatchObject({ status: 'assigned', assignee: 'ann' });
    expect(await s.resolve('a')).toMatchObject({ status: 'resolved', assignee: 'ann' });
    expect(await s.close('a')).toMatchObject({ status: 'closed', assignee: 'ann' });
  });
  it('lets assign replace the assignee from assigned and put a pending ticket back to assigned', async () => {
    const { s } = make();
    await s.create({ id: 'a', subject: 's' });
    await s.assign('a', 'ann');
    expect((await s.assign('a', 'bob')).assignee).toBe('bob');
    await s.wait('a');
    expect(await s.assign('a', 'cy')).toMatchObject({ status: 'assigned', assignee: 'cy' });
  });
  it('refuses every other transition with BAD_STATE and changes nothing', async () => {
    const { s } = make();
    await s.create({ id: 'a', subject: 's' });
    for (const call of [() => s.wait('a'), () => s.customerReply('a'), () => s.resolve('a'), () => s.reopen('a'), () => s.close('a')]) expect(await code(call)).toBe('BAD_STATE');
    expect(await s.get('a')).toMatchObject({ status: 'open', assignee: null });
    await s.assign('a', 'ann');
    for (const call of [() => s.customerReply('a'), () => s.reopen('a'), () => s.close('a')]) expect(await code(call)).toBe('BAD_STATE');
    await s.wait('a');
    for (const call of [() => s.wait('a'), () => s.resolve('a'), () => s.reopen('a'), () => s.close('a')]) expect(await code(call)).toBe('BAD_STATE');
    await s.customerReply('a'); await s.resolve('a');
    for (const call of [() => s.assign('a', 'bob'), () => s.wait('a'), () => s.customerReply('a'), () => s.resolve('a')]) expect(await code(call)).toBe('BAD_STATE');
    expect(await s.get('a')).toMatchObject({ status: 'resolved', assignee: 'ann' });
  });
  it('does not allow anything on a closed ticket', async () => {
    const { s } = make();
    await s.create({ id: 'a', subject: 's' }); await s.assign('a', 'ann'); await s.resolve('a'); await s.close('a');
    for (const call of [() => s.assign('a', 'x'), () => s.wait('a'), () => s.customerReply('a'), () => s.resolve('a'), () => s.reopen('a'), () => s.close('a')]) expect(await code(call)).toBe('BAD_STATE');
  });
});

describe('reopening and the automatic close', () => {
  it('reopens a resolved ticket, keeps the assignee and counts the reopening', async () => {
    const { s } = make();
    await s.create({ id: 'a', subject: 's' }); await s.assign('a', 'ann'); await s.resolve('a');
    expect(await s.reopen('a')).toMatchObject({ status: 'assigned', assignee: 'ann', reopenCount: 1 });
  });
  it('keeps a resolved ticket resolved until resolvedAt + reopenWindow and closes it at that moment', async () => {
    const { s, c } = make({ reopenWindow: 100 }, 10);
    await s.create({ id: 'a', subject: 's' }); await s.assign('a', 'ann');
    c.t = 20; await s.resolve('a');
    c.t = 119;
    expect(await status(s, 'a')).toBe('resolved');
    c.t = 120;
    expect(await status(s, 'a')).toBe('closed');
    expect(await code(() => s.reopen('a'))).toBe('BAD_STATE');
    expect((await s.list({ status: 'closed' })).map((t) => t.id)).toEqual(['a']);
    expect(await s.list({ status: 'resolved' })).toEqual([]);
  });
  it('can still reopen at the last minute of the window', async () => {
    const { s, c } = make({ reopenWindow: 100 });
    await s.create({ id: 'a', subject: 's' }); await s.assign('a', 'ann'); await s.resolve('a');
    c.t = 99;
    expect((await s.reopen('a')).status).toBe('assigned');
  });
  it('starts a new window each time the ticket is resolved again', async () => {
    const { s, c } = make({ reopenWindow: 50, maxReopens: 5 });
    await s.create({ id: 'a', subject: 's' }); await s.assign('a', 'ann'); await s.resolve('a');
    c.t = 40; await s.reopen('a'); c.t = 60; await s.resolve('a');
    c.t = 105;
    expect(await status(s, 'a')).toBe('resolved');
    c.t = 110;
    expect(await status(s, 'a')).toBe('closed');
  });
  it('allows maxReopens reopenings and refuses the next with REOPEN_LIMIT', async () => {
    const { s } = make({ maxReopens: 2 });
    await s.create({ id: 'a', subject: 's' }); await s.assign('a', 'ann');
    for (let i = 1; i <= 2; i += 1) { await s.resolve('a'); expect((await s.reopen('a')).reopenCount).toBe(i); }
    await s.resolve('a');
    expect(await code(() => s.reopen('a'))).toBe('REOPEN_LIMIT');
    expect(await s.get('a')).toMatchObject({ status: 'resolved', reopenCount: 2 });
  });
  it('refuses every reopening when maxReopens is 0', async () => {
    const { s } = make({ maxReopens: 0 });
    await s.create({ id: 'a', subject: 's' }); await s.assign('a', 'ann'); await s.resolve('a');
    expect(await code(() => s.reopen('a'))).toBe('REOPEN_LIMIT');
  });
  it('closes by hand before the window is over', async () => {
    const { s } = make();
    await s.create({ id: 'a', subject: 's' }); await s.assign('a', 'ann'); await s.resolve('a');
    await s.close('a');
    expect(await code(() => s.reopen('a'))).toBe('BAD_STATE');
  });
});

describe('escalation', () => {
  it('escalates an unassigned ticket exactly when createdAt + escalateAfter is reached', async () => {
    const { s, c } = make({ escalateAfter: 50 }, 10);
    await s.create({ id: 'a', subject: 's', priority: 'low' });
    c.t = 59;
    expect(await s.get('a')).toMatchObject({ priority: 'low', effectivePriority: 'low' });
    c.t = 60;
    expect(await s.get('a')).toMatchObject({ priority: 'low', effectivePriority: 'normal' });
  });
  it('never escalates a ticket that was assigned before the threshold', async () => {
    const { s, c } = make({ escalateAfter: 50 });
    await s.create({ id: 'a', subject: 's' });
    c.t = 49; await s.assign('a', 'ann');
    c.t = 500;
    expect((await s.get('a')).effectivePriority).toBe('normal');
  });
  it('counts an assignment at the threshold as too late, and keeps the ticket escalated afterwards', async () => {
    const { s, c } = make({ escalateAfter: 50 });
    await s.create({ id: 'a', subject: 's' });
    c.t = 50; await s.assign('a', 'ann');
    expect((await s.get('a')).effectivePriority).toBe('high');
    c.t = 1000;
    expect((await s.get('a')).effectivePriority).toBe('high');
  });
  it('escalates a ticket that was never read between creation and a late assignment', async () => {
    const { s, c } = make({ escalateAfter: 50 });
    await s.create({ id: 'a', subject: 's', priority: 'high' });
    c.t = 200;
    expect((await s.assign('a', 'ann')).effectivePriority).toBe('urgent');
  });
  it('caps the effective priority at urgent and measures each ticket from its own creation', async () => {
    const { s, c } = make({ escalateAfter: 50 });
    await s.create({ id: 'a', subject: 's', priority: 'urgent' });
    c.t = 30; await s.create({ id: 'b', subject: 's', priority: 'low' });
    c.t = 55;
    expect((await s.get('a')).effectivePriority).toBe('urgent');
    expect((await s.get('b')).effectivePriority).toBe('low');
    c.t = 80;
    expect((await s.get('b')).effectivePriority).toBe('normal');
  });
});

describe('merging', () => {
  it('folds the source into the target and keeps the target status and assignee', async () => {
    const { s } = make();
    await s.create({ id: 'a', subject: 's' }); await s.create({ id: 'b', subject: 't' });
    await s.assign('b', 'bob');
    const target = await s.merge('a', 'b');
    expect(target).toMatchObject({ id: 'b', status: 'assigned', assignee: 'bob' });
    expect(await s.get('a')).toEqual({ id: 'a', subject: 's', priority: 'normal', effectivePriority: 'normal', status: 'merged', assignee: null, reopenCount: 0, mergedInto: 'b' });
    expect('mergedInto' in (await s.get('b'))).toBe(false);
  });
  it('gives the target the higher of the two priorities, whichever way round', async () => {
    const { s } = make();
    await s.create({ id: 'a', subject: 's', priority: 'high' }); await s.create({ id: 'b', subject: 't', priority: 'low' });
    expect((await s.merge('a', 'b')).priority).toBe('high');
    await s.create({ id: 'c', subject: 's', priority: 'low' }); await s.create({ id: 'd', subject: 't', priority: 'urgent' });
    expect((await s.merge('c', 'd')).priority).toBe('urgent');
  });
  it('carries an escalation over to the target and does not invent one', async () => {
    const { s, c } = make({ escalateAfter: 50 });
    await s.create({ id: 'old', subject: 's', priority: 'low' });
    c.t = 40; await s.create({ id: 'new', subject: 't', priority: 'low' });
    c.t = 55;
    expect((await s.get('new')).effectivePriority).toBe('low');
    expect((await s.merge('old', 'new')).effectivePriority).toBe('normal');
    c.t = 500;
    await s.create({ id: 'x', subject: 'x', priority: 'low' }); await s.create({ id: 'y', subject: 'y', priority: 'low' });
    c.t = 501; await s.assign('x', 'ann'); await s.assign('y', 'bob');
    await s.merge('y', 'x');
    expect((await s.get('x')).effectivePriority).toBe('low');
  });
  it('refuses to merge a ticket into itself, into a finished ticket or from one', async () => {
    const { s } = make();
    for (const id of ['a', 'b', 'c']) await s.create({ id, subject: id });
    await s.assign('b', 'bob'); await s.resolve('b');
    expect(await code(() => s.merge('a', 'a'))).toBe('SAME_TICKET');
    expect(await code(() => s.merge('a', 'b'))).toBe('BAD_STATE');
    expect(await code(() => s.merge('b', 'a'))).toBe('BAD_STATE');
    await s.merge('c', 'a');
    expect(await code(() => s.merge('c', 'a'))).toBe('BAD_STATE');
    expect(await code(() => s.merge('a', 'c'))).toBe('BAD_STATE');
    expect(await code(() => s.assign('c', 'zed'))).toBe('BAD_STATE');
    expect(await s.get('a')).toMatchObject({ status: 'open' });
  });
  it('changes nothing when a merge fails', async () => {
    const { s } = make();
    await s.create({ id: 'a', subject: 's', priority: 'urgent' }); await s.create({ id: 'b', subject: 't', priority: 'low' });
    await s.assign('b', 'bob'); await s.resolve('b');
    await code(() => s.merge('a', 'b'));
    expect(await s.get('a')).toMatchObject({ status: 'open', priority: 'urgent' });
    expect(await s.get('b')).toMatchObject({ status: 'resolved', priority: 'low' });
  });
  it('can merge a pending ticket and still lets the target be worked on', async () => {
    const { s } = make();
    await s.create({ id: 'a', subject: 's' }); await s.create({ id: 'b', subject: 't' });
    await s.assign('a', 'ann'); await s.wait('a');
    await s.merge('a', 'b');
    expect(await s.assign('b', 'bob')).toMatchObject({ status: 'assigned', assignee: 'bob' });
  });
});

describe('listing', () => {
  it('sorts by effective priority, then by creation order', async () => {
    const { s, c } = make({ escalateAfter: 50 });
    await s.create({ id: 'n2', subject: 's' });
    await s.create({ id: 'u1', subject: 's', priority: 'urgent' });
    await s.create({ id: 'l1', subject: 's', priority: 'low' });
    await s.create({ id: 'h1', subject: 's', priority: 'high' });
    await s.create({ id: 'n1', subject: 's' });
    expect((await s.list()).map((t) => t.id)).toEqual(['u1', 'h1', 'n2', 'n1', 'l1']);
    await s.assign('l1', 'ann'); await s.assign('n1', 'ann'); await s.assign('n2', 'ann'); await s.assign('h1', 'ann'); await s.assign('u1', 'ann');
    c.t = 100;
    expect((await s.list()).map((t) => t.id)).toEqual(['u1', 'h1', 'n2', 'n1', 'l1']);
  });
  it('ranks an escalated ticket with the tickets of its new effective priority, in creation order', async () => {
    const { s, c } = make({ escalateAfter: 50 });
    await s.create({ id: 'zeta', subject: 's', priority: 'low' });
    c.t = 30;
    await s.create({ id: 'alpha', subject: 's', priority: 'normal' });
    await s.assign('alpha', 'bob');
    c.t = 60;
    expect((await s.list()).map((t) => [t.id, t.effectivePriority])).toEqual([['zeta', 'normal'], ['alpha', 'normal']]);
  });
  it('filters by status and assignee together and validates the status', async () => {
    const { s } = make();
    for (const id of ['a', 'b', 'c']) await s.create({ id, subject: id });
    await s.assign('a', 'ann'); await s.assign('b', 'bob'); await s.assign('c', 'ann'); await s.wait('c');
    expect((await s.list({ assignee: 'ann' })).map((t) => t.id)).toEqual(['a', 'c']);
    expect((await s.list({ assignee: 'ann', status: 'pending' })).map((t) => t.id)).toEqual(['c']);
    expect(await s.list({ status: 'open' })).toEqual([]);
    expect(await code(() => s.list({ status: 'weird' }))).toBe('INVALID_INPUT');
    expect((await s.list({})).length).toBe(3);
  });
  it('shows merged tickets with their own status and no assignee unless they had one', async () => {
    const { s } = make();
    await s.create({ id: 'a', subject: 's' }); await s.create({ id: 'b', subject: 't' });
    await s.merge('a', 'b');
    expect((await s.list({ status: 'merged' })).map((t) => [t.id, t.mergedInto])).toEqual([['a', 'b']]);
  });
});
