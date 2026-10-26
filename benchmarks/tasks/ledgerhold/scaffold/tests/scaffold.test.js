import {it,expect} from 'vitest';
import {createLedger} from '../src/ledger.js';
it('public export exists',()=>{expect(typeof createLedger).toBe('function');});
