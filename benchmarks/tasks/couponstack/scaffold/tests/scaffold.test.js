import {it,expect} from 'vitest';
import {createCoupons} from '../src/coupons.js';
it('public export exists',()=>{expect(typeof createCoupons).toBe('function');});
