// Hidden grader for RoomBookings. It asserts only what SPEC.md decides.
import { describe, expect, it } from 'vitest';
import { createBookings } from '../src/bookings.js';

const code = async (fn) => { try { await fn(); } catch (error) { return error?.code ?? `NO_CODE:${error?.message}`; } return 'NO_ERROR'; };
const clock = (start = 0) => { const c = { t: start, now: () => c.t }; return c; };
const make = (options = {}) => { const c = options.clock ?? clock(0); const b = createBookings({ rooms: ['r1', 'r2'], holdTtl: 100, now: c.now, ...options.config }); return { b, c }; };
const hold = (b, id, start, end, room = 'r1') => b.hold({ id, room, start, end });

describe('validation', () => {
  it('rejects invalid options with INVALID_INPUT', async () => {
    for (const options of [{ rooms: 'r1' }, { rooms: ['a', 'a'] }, { rooms: [''] }, { rooms: [1] }, { holdTtl: 0 }, { holdTtl: 1.5 }, { maxDuration: 0 }, { maxDuration: -1 }]) {
      expect(await code(() => createBookings(options)), JSON.stringify(options)).toBe('INVALID_INPUT');
    }
  });
  it('rejects bad ids, rooms and intervals with the specified codes', async () => {
    const { b } = make();
    for (const id of ['', 5, undefined]) expect(await code(() => hold(b, id, 0, 10)), String(id)).toBe('INVALID_INPUT');
    expect(await code(() => b.hold({ id: 'x', room: 'nope', start: 0, end: 10 }))).toBe('UNKNOWN_ROOM');
    for (const [start, end] of [[10, 10], [10, 5], [-1, 5], [1.5, 5], [0, 5.5], ['0', 5]]) expect(await code(() => hold(b, 'x', start, end)), `${start},${end}`).toBe('INVALID_INTERVAL');
    expect(await code(() => b.get('x'))).toBe('UNKNOWN_BOOKING');
  });
  it('allows exactly maxDuration and refuses one minute more', async () => {
    const { b } = make();
    expect((await hold(b, 'ok', 100, 580)).end).toBe(580);
    expect(await code(() => hold(b, 'long', 1000, 1481))).toBe('TOO_LONG');
    const small = make({ config: { maxDuration: 30 } }).b;
    expect((await hold(small, 'a', 0, 30)).status).toBe('held');
    expect(await code(() => hold(small, 'b', 100, 131))).toBe('TOO_LONG');
  });
  it('allows a start equal to now but not before it', async () => {
    const c = clock(10);
    const { b } = make({ clock: c });
    expect(await code(() => hold(b, 'late', 9, 20))).toBe('IN_THE_PAST');
    expect((await hold(b, 'now', 10, 20)).status).toBe('held');
  });
  it('keeps an id taken forever, but not when the hold was refused', async () => {
    const c = clock(0);
    const { b } = make({ clock: c });
    await hold(b, 'a', 0, 10);
    await b.cancel('a');
    expect(await code(() => hold(b, 'a', 50, 60))).toBe('ID_TAKEN');
    await hold(b, 'e', 100, 110);
    c.t = 100;
    expect(await code(() => hold(b, 'e', 200, 210))).toBe('ID_TAKEN');
    await hold(b, 'blocker', 300, 400);
    expect(await code(() => hold(b, 'refused', 350, 360))).toBe('CONFLICT');
    expect((await hold(b, 'refused', 500, 510)).status).toBe('held');
  });
});

describe('views', () => {
  it('has the specified fields for held, confirmed, cancelled and expired bookings', async () => {
    const c = clock(5);
    const { b } = make({ clock: c });
    const held = await hold(b, 'h', 10, 20);
    expect(Object.keys(held).sort()).toEqual(['end', 'expiresAt', 'id', 'room', 'start', 'status']);
    expect(held).toEqual({ id: 'h', room: 'r1', start: 10, end: 20, status: 'held', expiresAt: 105 });
    const confirmed = await b.confirm('h');
    expect(confirmed).toEqual({ id: 'h', room: 'r1', start: 10, end: 20, status: 'confirmed' });
    await hold(b, 'c', 30, 40);
    expect(await b.cancel('c')).toEqual({ id: 'c', room: 'r1', start: 30, end: 40, status: 'cancelled' });
    await hold(b, 'x', 50, 60);
    c.t = 105;
    expect(await b.get('x')).toEqual({ id: 'x', room: 'r1', start: 50, end: 60, status: 'expired' });
  });
});

describe('overlap rules (half-open intervals)', () => {
  it('lets intervals that only touch coexist, in both orders', async () => {
    const { b } = make();
    await hold(b, 'mid', 10, 20);
    expect((await hold(b, 'before', 0, 10)).status).toBe('held');
    expect((await hold(b, 'after', 20, 30)).status).toBe('held');
    expect((await b.list('r1')).map((v) => v.id)).toEqual(['before', 'mid', 'after']);
  });
  it('refuses any real overlap: by one minute, containing, contained and identical', async () => {
    const { b } = make();
    await hold(b, 'base', 10, 20);
    for (const [start, end] of [[0, 11], [19, 30], [12, 15], [5, 25], [10, 20]]) expect(await code(() => hold(b, `x${start}-${end}`, start, end)), `${start}-${end}`).toBe('CONFLICT');
    expect((await b.list('r1')).map((v) => v.id)).toEqual(['base']);
  });
  it('never conflicts across rooms', async () => {
    const { b } = make();
    await hold(b, 'a', 10, 20, 'r1');
    expect((await hold(b, 'b', 10, 20, 'r2')).status).toBe('held');
  });
  it('lets a confirmed booking block overlapping holds', async () => {
    const { b } = make();
    await hold(b, 'a', 10, 20);
    await b.confirm('a');
    expect(await code(() => hold(b, 'b', 15, 25))).toBe('CONFLICT');
  });
});

describe('hold expiry', () => {
  it('is active while now < t + holdTtl and expired from exactly t + holdTtl', async () => {
    const c = clock(5);
    const { b } = make({ clock: c });
    await hold(b, 'h', 200, 210);
    c.t = 104;
    expect(await b.get('h')).toMatchObject({ status: 'held', expiresAt: 105 });
    expect(await code(() => hold(b, 'other', 200, 210))).toBe('CONFLICT');
    c.t = 105;
    expect((await b.get('h')).status).toBe('expired');
    expect(await b.list('r1')).toEqual([]);
  });
  it('frees the slot at the very moment of expiry', async () => {
    const c = clock(0);
    const { b } = make({ clock: c, config: { holdTtl: 50 } });
    await hold(b, 'first', 100, 110);
    c.t = 49;
    expect(await code(() => hold(b, 'second', 100, 110))).toBe('CONFLICT');
    c.t = 50;
    expect((await hold(b, 'second', 100, 110)).status).toBe('held');
  });
  it('lets a hold be confirmed up to the last tick and then refuses with HOLD_EXPIRED', async () => {
    const c = clock(0);
    const { b } = make({ clock: c, config: { holdTtl: 10 } });
    await hold(b, 'a', 100, 110);
    await hold(b, 'b', 200, 210);
    c.t = 9;
    expect((await b.confirm('a')).status).toBe('confirmed');
    c.t = 10;
    expect(await code(() => b.confirm('b'))).toBe('HOLD_EXPIRED');
    expect((await b.get('b')).status).toBe('expired');
  });
  it('does not expire a confirmed booking, even long after its end', async () => {
    const c = clock(0);
    const { b } = make({ clock: c, config: { holdTtl: 10 } });
    await hold(b, 'a', 5, 15);
    await b.confirm('a');
    c.t = 100000;
    expect(await b.get('a')).toEqual({ id: 'a', room: 'r1', start: 5, end: 15, status: 'confirmed' });
    expect((await b.list('r1', { from: 0, to: 20 })).map((v) => v.id)).toEqual(['a']);
  });
});

describe('confirm', () => {
  it('is idempotent and reports the specified errors', async () => {
    const { b } = make();
    await hold(b, 'a', 10, 20);
    const first = await b.confirm('a');
    expect(await b.confirm('a')).toEqual(first);
    await hold(b, 'c', 30, 40);
    await b.cancel('c');
    expect(await code(() => b.confirm('c'))).toBe('ALREADY_CANCELLED');
    expect(await code(() => b.confirm('ghost'))).toBe('UNKNOWN_BOOKING');
  });
});

describe('cancel', () => {
  it('cancels an active hold at any time before it expires and frees the slot at once', async () => {
    const c = clock(0);
    const { b } = make({ clock: c, config: { holdTtl: 20 } });
    await hold(b, 'a', 50, 60);
    c.t = 19;
    expect((await b.cancel('a')).status).toBe('cancelled');
    expect((await hold(b, 'b', 50, 60)).status).toBe('held');
  });
  it('refuses to cancel an expired hold with HOLD_EXPIRED', async () => {
    const c = clock(0);
    const { b } = make({ clock: c, config: { holdTtl: 20 } });
    await hold(b, 'a', 50, 60);
    c.t = 20;
    expect(await code(() => b.cancel('a'))).toBe('HOLD_EXPIRED');
  });
  it('returns an already cancelled booking unchanged', async () => {
    const { b } = make();
    await hold(b, 'a', 10, 20);
    const first = await b.cancel('a');
    expect(await b.cancel('a')).toEqual(first);
    expect(await code(() => b.cancel('ghost'))).toBe('UNKNOWN_BOOKING');
  });
  it('cancels a confirmed booking only while now < start', async () => {
    const c = clock(0);
    const { b } = make({ clock: c, config: { holdTtl: 1000 } });
    await hold(b, 'early', 50, 60);
    await b.confirm('early');
    await hold(b, 'edge', 100, 110);
    await b.confirm('edge');
    await hold(b, 'later', 200, 210);
    await b.confirm('later');
    c.t = 49;
    expect((await b.cancel('early')).status).toBe('cancelled');
    c.t = 100;
    expect(await code(() => b.cancel('edge'))).toBe('TOO_LATE');
    expect((await b.get('edge')).status).toBe('confirmed');
    c.t = 205;
    expect(await code(() => b.cancel('later'))).toBe('TOO_LATE');
    expect((await b.get('later')).status).toBe('confirmed');
  });
  it('lets a hold whose start has passed still be cancelled while it is active', async () => {
    const c = clock(0);
    const { b } = make({ clock: c });
    await hold(b, 'a', 10, 20);
    c.t = 50;
    expect((await b.cancel('a')).status).toBe('cancelled');
  });
});

describe('list', () => {
  it('returns only active bookings of the room, sorted by start', async () => {
    const c = clock(0);
    const { b } = make({ clock: c, config: { holdTtl: 30 } });
    await hold(b, 'c', 300, 310);
    await hold(b, 'a', 100, 110);
    await hold(b, 'dead', 200, 210);
    await b.cancel('dead');
    await hold(b, 'other-room', 100, 110, 'r2');
    await b.confirm('a');
    c.t = 10;
    await hold(b, 'late', 400, 410);
    c.t = 30;
    expect((await b.list('r1')).map((v) => v.id)).toEqual(['a', 'late']);
    expect((await b.list('r2')).map((v) => v.id)).toEqual([]);
  });
  it('treats the window as half-open on both ends', async () => {
    const { b } = make();
    await hold(b, 'a', 10, 20);
    const ids = async (window) => (await b.list('r1', window)).map((v) => v.id);
    expect(await ids({ from: 20 })).toEqual([]);
    expect(await ids({ from: 19 })).toEqual(['a']);
    expect(await ids({ to: 10 })).toEqual([]);
    expect(await ids({ to: 11 })).toEqual(['a']);
    expect(await ids({ from: 10, to: 20 })).toEqual(['a']);
    expect(await ids({ from: 0, to: 1000 })).toEqual(['a']);
    expect(await ids({})).toEqual(['a']);
  });
  it('rejects invalid windows and unknown rooms', async () => {
    const { b } = make();
    for (const window of [{ from: 5, to: 5 }, { from: 6, to: 5 }, { from: 1.5 }, { to: 2.5 }]) expect(await code(() => b.list('r1', window)), JSON.stringify(window)).toBe('INVALID_INTERVAL');
    expect(await code(() => b.list('nope'))).toBe('UNKNOWN_ROOM');
  });
});
