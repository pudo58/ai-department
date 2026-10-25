import type { CheckResult, HumanTime, Mode, Run, RunSummary } from '../shared/types';

/** Each status has its own pastel color: blue waits for acceptance, purple for contract approval, orange is blocked. */
export const STATUS: Record<Run['status'], { label: string; tone: string }> = {
  draft: { label: 'Nháp', tone: 'gray' }, awaiting_approval: { label: 'Chờ duyệt hợp đồng', tone: 'purple' }, queued: { label: 'Trong hàng đợi', tone: 'blue' },
  running: { label: 'Đang chạy', tone: 'blue' }, paused: { label: 'Tạm dừng', tone: 'gray' }, blocked: { label: 'Bị chặn', tone: 'orange' },
  awaiting_acceptance: { label: 'Chờ nghiệm thu', tone: 'blue' }, completed: { label: 'Hoàn thành', tone: 'green' }, failed: { label: 'Thất bại', tone: 'red' },
};
export function runStatus(run: Pick<RunSummary, 'status' | 'deliveryStatus'>): { label: string; tone: string } {
  if (run.deliveryStatus === 'in_progress') return { label: 'Đang giao kết quả', tone: 'blue' };
  if (run.deliveryStatus === 'failed') return { label: 'Chưa giao được kết quả', tone: 'red' };
  if (run.deliveryStatus === 'unknown' || (run.status === 'completed' && run.deliveryStatus !== 'succeeded')) return { label: 'Chưa xác nhận giao', tone: 'orange' };
  return STATUS[run.status];
}
export const MODE_LABEL: Record<Mode, string> = { single: 'Single', clarify: 'Team · Clarify', verify: 'Team · Verify', compare: 'Team · Compare' };
export const CHECK_TONE: Record<CheckResult['status'], string> = { passed: 'good', failed: 'bad', flaky: 'warn', incomplete: 'warn' };
export const CHECK_LABEL: Record<CheckResult['status'], string> = { passed: 'Pass', failed: 'Fail', flaky: 'Flaky', incomplete: 'Chưa hoàn tất' };
export const ROW_LABEL = { verified: 'Đã xác minh', unverified: 'Chưa xác minh', failed: 'Fail', manual_pending: 'Chờ thủ công' } as const;
export const ROW_TONE = { verified: 'good', unverified: 'warn', failed: 'bad', manual_pending: 'neutral' } as const;
export const TIME_CATEGORIES: Record<HumanTime['category'], string> = {
  clarification: 'Làm rõ yêu cầu', approval: 'Duyệt plan/policy', review: 'Xử lý finding/bất đồng', quota: 'Quota/chuyển chế độ',
  acceptance: 'Nghiệm thu', rework: 'Sửa sau bàn giao', onboarding: 'Onboarding', research: 'Chấm mù/nghiên cứu',
};

export const ACTIVE: Run['status'][] = ['queued', 'running'];
/** Everything that is waiting on a person, as opposed to running or finished. */
export const NEEDS_YOU: Run['status'][] = ['draft', 'awaiting_approval', 'paused', 'blocked', 'failed', 'awaiting_acceptance'];

export type StepKind = 'idle' | 'running' | 'attention' | 'bad';
export const STEPS = ['Hợp đồng', 'Triển khai', 'Kiểm chứng', 'Nghiệm thu'] as const;

/** Where a task is in the pipeline: index of the current step (4 = all done) and how it should look. */
export function pipelineStep(run: Pick<RunSummary, 'status' | 'stage' | 'contractApproved' | 'deliveryStatus'>): { index: number; kind: StepKind } {
  if (run.status === 'completed' && run.deliveryStatus !== 'succeeded') return { index: 3, kind: 'attention' };
  const kind: StepKind = run.status === 'failed' ? 'bad' : ACTIVE.includes(run.status) ? 'running' : run.status === 'completed' ? 'idle' : 'attention';
  if (run.status === 'completed') return { index: STEPS.length, kind };
  if (run.status === 'awaiting_acceptance') return { index: 3, kind };
  if (run.status === 'draft' || run.status === 'awaiting_approval' || !run.contractApproved || run.stage === 'prepare') return { index: 0, kind };
  return { index: run.stage === 'verify' ? 2 : 1, kind };
}
