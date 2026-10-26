import {it,expect} from 'vitest';
import {compareVersions} from '../src/versions.js';
it('public export exists',()=>{expect(typeof compareVersions).toBe('function');});
