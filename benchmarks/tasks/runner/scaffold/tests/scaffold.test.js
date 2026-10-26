import {it,expect} from 'vitest';
import {createRunner} from '../src/runner.js';
it('public export exists',()=>{expect(typeof createRunner).toBe('function');});
