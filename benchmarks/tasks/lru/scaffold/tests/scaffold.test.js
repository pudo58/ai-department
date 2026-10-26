import {it,expect} from 'vitest';
import {createLru} from '../src/lru.js';
it('public export exists',()=>{expect(typeof createLru).toBe('function');});
