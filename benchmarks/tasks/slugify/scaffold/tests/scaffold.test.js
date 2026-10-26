import {it,expect} from 'vitest';
import {slugify} from '../src/slugify.js';
it('public export exists',()=>{expect(typeof slugify).toBe('function');});
