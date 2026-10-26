function fail(code, message) {
  const error = new Error(message ?? code);
  error.code = code;
  return error;
}
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isPositive = (v) => Number.isSafeInteger(v) && v > 0;
const overlaps = (a, b) => a.start < b.end && b.start < a.end;
const text = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function createBookings({ rooms = [], holdTtl = 100, now = () => 0, maxDuration = 480 } = {}) {
  if (!Array.isArray(rooms) || rooms.some((r) => typeof r !== 'string' || r.length === 0) || new Set(rooms).size !== rooms.length || !isPositive(holdTtl) || !isPositive(maxDuration)) throw fail('INVALID_INPUT');
  const known = new Set(rooms);
  const bookings = new Map();

  const statusOf = (b) => (b.status === 'held' && now() >= b.heldAt + holdTtl ? 'expired' : b.status);
  const view = (b) => {
    const status = statusOf(b);
    const out = { id: b.id, room: b.room, start: b.start, end: b.end, status };
    if (status === 'held') out.expiresAt = b.heldAt + holdTtl;
    return out;
  };
  const active = (b) => ['held', 'confirmed'].includes(statusOf(b));
  const need = (id) => {
    const b = bookings.get(id);
    if (!b) throw fail('UNKNOWN_BOOKING', String(id));
    return b;
  };
  const room = (name) => {
    if (!known.has(name)) throw fail('UNKNOWN_ROOM', String(name));
  };

  return {
    hold(input) {
      const { id, room: name, start, end } = input ?? {};
      if (typeof id !== 'string' || id.length === 0) throw fail('INVALID_INPUT', 'id');
      room(name);
      if (!isTime(start) || !isTime(end) || start >= end) throw fail('INVALID_INTERVAL');
      if (end - start > maxDuration) throw fail('TOO_LONG');
      if (start < now()) throw fail('IN_THE_PAST');
      if (bookings.has(id)) throw fail('ID_TAKEN', id);
      for (const other of bookings.values()) if (other.room === name && active(other) && overlaps(other, { start, end })) throw fail('CONFLICT');
      const booking = { id, room: name, start, end, status: 'held', heldAt: now() };
      bookings.set(id, booking);
      return view(booking);
    },
    confirm(id) {
      const b = need(id);
      const status = statusOf(b);
      if (status === 'confirmed') return view(b);
      if (status === 'expired') throw fail('HOLD_EXPIRED');
      if (status === 'cancelled') throw fail('ALREADY_CANCELLED');
      b.status = 'confirmed';
      return view(b);
    },
    cancel(id) {
      const b = need(id);
      const status = statusOf(b);
      if (status === 'cancelled') return view(b);
      if (status === 'expired') throw fail('HOLD_EXPIRED');
      if (status === 'confirmed' && now() >= b.start) throw fail('TOO_LATE');
      b.status = 'cancelled';
      return view(b);
    },
    get: (id) => view(need(id)),
    list(name, window = {}) {
      room(name);
      const { from = 0, to = Number.POSITIVE_INFINITY } = window ?? {};
      if (!Number.isSafeInteger(from) || from < 0 || (to !== Number.POSITIVE_INFINITY && !Number.isSafeInteger(to)) || from >= to) throw fail('INVALID_INTERVAL');
      return [...bookings.values()].filter((b) => b.room === name && active(b) && overlaps(b, { start: from, end: to }))
        .sort((a, b) => a.start - b.start || text(a.id, b.id)).map(view);
    },
  };
}
