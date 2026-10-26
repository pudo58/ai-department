import {it,expect} from 'vitest';
import {createTickets} from '../src/tickets.js';
it('public export exists',()=>{expect(typeof createTickets).toBe('function');});
