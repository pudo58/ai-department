import {it,expect} from 'vitest';
import {createScheduler,restoreScheduler} from '../src/scheduler.js';
it('public exports exist',()=>{expect(typeof createScheduler).toBe('function');expect(typeof restoreScheduler).toBe('function');});
