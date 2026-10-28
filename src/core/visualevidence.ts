import type { Artifact, Run } from '../shared/types.js';
import type { VisualReport, VisualProfile } from '../shared/visual.js';
import { canonicalJson, sha256 } from './contract.js';

export const VISUAL_REPORT_TITLE = 'Visual verification';
export const visualProfileHash = (profile: VisualProfile) => sha256(canonicalJson(profile));

/** Only harness artifacts for this exact source, checkpoint, contract and profile can contribute evidence. */
export function readVisualReport(run: Run, artifacts: readonly Artifact[]): VisualReport | undefined {
  const binding = run.contract.design, profile = run.configSnapshot.visualCheck;
  if (!binding || !profile || !run.checkpoint) return;
  for (const artifact of [...artifacts].reverse()) {
    if (artifact.title !== VISUAL_REPORT_TITLE || artifact.kind !== 'report' || !artifact.valid || artifact.checkpoint !== run.checkpoint || artifact.contractVersion !== run.contract.version || artifact.hash !== sha256(artifact.content)) continue;
    try {
      const r = JSON.parse(artifact.content) as VisualReport;
      if (r.schemaVersion === 1 && r.source === 'harness' && /^vis_[a-f0-9]{32}$/.test(r.id) && r.runId === run.id && r.checkpoint === run.checkpoint && r.slot === run.selectedSlot && r.contractVersion === run.contract.version && r.snapshotId === binding.snapshotId && r.snapshotHash === binding.snapshotHash && r.profileHash === visualProfileHash(profile) && Array.isArray(r.screens) && (r.screens.length || r.status === 'incomplete') && ['passed', 'needs_review', 'incomplete'].includes(r.status)) return r;
    } catch { /* Unreadable evidence is unknown. */ }
  }
}

/** Once a project sets an acceptance tolerance, a missing or unstable measurement cannot silently pass its automatic gate. */
export function visualBlockers(run: Run, artifacts: readonly Artifact[]): string[] {
  if (!run.contract.design || !run.configSnapshot.visualCheck || run.configSnapshot.visualCheck.maxDiffRatio === undefined || run.provider === 'fake') return [];
  const report = readVisualReport(run, artifacts);
  if (!report) return ['Chưa chạy đối chiếu hình ảnh trên checkpoint và profile hiện tại.'];
  if (report.status === 'incomplete') return ['Đối chiếu hình ảnh chưa hoàn tất hoặc ảnh không ổn định. Xem report, sửa môi trường/profile rồi chạy lại.'];
  return [];
}
