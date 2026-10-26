import {it,expect} from 'vitest';
import {mergeRanges} from '../src/ranges.js';
it('public export exists',()=>{expect(typeof mergeRanges).toBe('function');});
