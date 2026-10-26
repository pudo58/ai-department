import {it,expect} from 'vitest';
import {createBookings} from '../src/bookings.js';
it('public export exists',()=>{expect(typeof createBookings).toBe('function');});
