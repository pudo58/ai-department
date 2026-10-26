import {it,expect} from 'vitest';
import {createCharges} from '../src/charges.js';
it('public export exists',()=>{expect(typeof createCharges).toBe('function');});
