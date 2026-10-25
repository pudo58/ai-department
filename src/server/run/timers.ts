import { randomUUID } from 'node:crypto';
import type { HumanTime, Run } from '../../shared/types.js';
import { HttpError } from './support.js';
import type { RunServices } from './services.js';

/** Human time on a task: running timers and manual entries, closed when the task is accepted. */
export class HumanTimers {
  constructor(private readonly s: RunServices) {}

  startTimer(runId: string, category: HumanTime['category'], note = ''): HumanTime {
    this.s.assertNotDelivering(runId);
    this.s.run(runId);
    const timer: HumanTime = { id: `ht_${randomUUID().slice(0, 8)}`, category, startedAt: this.s.stamp(), note };
    this.s.mutate(runId, (r) => { r.humanTime.push(timer); });
    return timer;
  }

  stopTimer(runId: string, timerId: string): HumanTime {
    this.s.assertNotDelivering(runId);
    let stopped: HumanTime | undefined;
    this.s.mutate(runId, (r) => {
      stopped = r.humanTime.find((t) => t.id === timerId);
      if (!stopped) throw new HttpError(404, 'Bộ đếm không tồn tại.');
      if (!stopped.endedAt) this.closeTimer(stopped);
    });
    return stopped!;
  }

  /** Manual entry for corrections and work done away from the screen (e.g. post-delivery fixes). */
  addHumanMinutes(runId: string, category: HumanTime['category'], minutes: number, note = ''): HumanTime {
    this.s.assertNotDelivering(runId);
    if (!(minutes >= 0) || minutes > 24 * 60) throw new HttpError(400, 'Số phút không hợp lệ.');
    const end = this.s.now();
    const entry: HumanTime = { id: `ht_${randomUUID().slice(0, 8)}`, category, startedAt: new Date(end.getTime() - minutes * 60_000).toISOString(), endedAt: end.toISOString(), durationMs: minutes * 60_000, note: note || 'Nhập thủ công' };
    this.s.mutate(runId, (r) => { r.humanTime.push(entry); });
    return entry;
  }

  private closeTimer(t: HumanTime): void { t.endedAt = this.s.stamp(); t.durationMs = Math.max(0, Date.parse(t.endedAt) - Date.parse(t.startedAt)); }

  closeTimers(run: Run): void { run.humanTime.filter((t) => !t.endedAt).forEach((t) => this.closeTimer(t)); }
}
