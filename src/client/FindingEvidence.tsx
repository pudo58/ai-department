import { useEffect, useState } from 'react';
import type { Finding, RunDetail } from '../shared/types';
import type { FindingProof, PendingRegression, RegressionTrial } from '../shared/regression';
import { Badge, DiffView } from './ui';
import { ReasonModal } from './RunPanels';

const TRIAL: Record<RegressionTrial['status'], { label: string; tone: string }> = {
  failed_as_expected: { label: 'Thất bại đúng chỗ replay thấy sai khác', tone: 'good' },
  passed_unexpectedly: { label: 'Đạt trên mã đang lỗi: chưa tái hiện được', tone: 'bad' },
  wrong_failure: { label: 'Thất bại nhưng không phải ở bước đã thấy', tone: 'bad' },
  discovery_error: { label: 'Chưa chạy được (nhận file hoặc import)', tone: 'bad' },
  breaks_checks: { label: 'Làm hỏng check bắt buộc khác (ví dụ typecheck)', tone: 'bad' },
  error: { label: 'Lỗi khi thử', tone: 'bad' }, timeout: { label: 'Hết thời gian', tone: 'warn' }, interrupted: { label: 'Bị gián đoạn', tone: 'warn' },
};
const LEVEL: Record<FindingProof['level'], { label: string; tone: string }> = {
  proven_fixed: { label: 'Đã chứng minh sửa xong', tone: 'good' }, reproduced: { label: 'Tái hiện được, chưa sửa', tone: 'bad' },
  not_reproduced: { label: 'Không còn tái hiện, chưa có bằng chứng trước/sau', tone: 'warn' }, unverified: { label: 'Chưa kiểm chứng', tone: 'neutral' },
  manual_decision: { label: 'Đóng bằng quyết định thủ công', tone: 'warn' },
};

/** The oracle, what the runner saw, how the generated test behaved on a clone, and the exact diff that would be added. */
export function RegressionProposalView({ proposal }: { proposal: PendingRegression }) {
  return <div className="notice-line" aria-label="Đề xuất test regression">
    <p><strong>Căn cứ của kịch bản</strong></p>
    {proposal.oracle.references.map((ref, i) => <p key={i}><code>{ref.requirementId}</code>: {ref.quote}</p>)}
    <p>{proposal.oracle.explanation}</p>
    <p><strong>Runner đã thấy:</strong> {proposal.replay.message}</p>
    {proposal.unsupported
      ? <p className="banner warn"><span><strong>Chưa tạo được test regression tự động.</strong> {proposal.unsupported}</span></p>
      : <>
        <p><strong>Test regression dự kiến:</strong> <code>{proposal.path}</code>{' '}{proposal.trial && <Badge tone={TRIAL[proposal.trial.status].tone}>{TRIAL[proposal.trial.status].label}</Badge>}</p>
        {proposal.trial && <p className="small muted">{proposal.trial.message}</p>}
        <details><summary>Đọc diff test sẽ được thêm vào project</summary>{proposal.patch && <DiffView text={proposal.patch}/>}</details>
      </>}
  </div>;
}

/**
 * v4 finding actions. Confirming names the proposal that was read (by its hash); a finding without a usable regression can only be
 * confirmed or closed with a reason. Nothing here calls an agent except "Sửa".
 */
export function FindingActions({ detail, finding, busy, onFinding, onDispute }: { detail: RunDetail; finding: Finding; busy: boolean; onFinding: (id: string, action: 'confirm' | 'resolve' | 'dispute' | 'replay', body?: unknown) => Promise<void>; onDispute: () => void }) {
  const proposal = detail.regressionProposals?.find(p => p.findingId === finding.id);
  const ready = !!proposal && !proposal.unsupported && proposal.trial?.status === 'failed_as_expected';
  const [read, setRead] = useState(false);
  const [modal, setModal] = useState<'manual' | 'resolve' | null>(null);
  useEffect(() => { setRead(false); }, [proposal?.hash]);
  const open = detail.run.status !== 'running' && detail.run.status !== 'queued';
  return <div className="stack">
    {proposal && <RegressionProposalView proposal={proposal}/>}
    {finding.confirmation && <p className="small muted">{finding.confirmation.kind === 'regression' ? 'Đã xác nhận theo đề xuất regression bạn đã đọc.' : `Đã xác nhận bằng review thủ công: ${finding.confirmation.reason}`}</p>}
    {finding.resolution?.kind === 'manual_review' && <p className="small muted">Đóng bằng quyết định thủ công (không phải runner xác minh): {finding.resolution.reason}</p>}
    {finding.status !== 'resolved' && <div className="row-actions" style={{ marginBottom: 0 }}>
      {!finding.confirmed && ready && <label className="ack"><input type="checkbox" checked={read} onChange={e => setRead(e.target.checked)}/> Tôi đã đọc căn cứ và diff, đồng ý thêm test này làm regression</label>}
      {!finding.confirmed && ready && <button className="button small" disabled={busy || !open || !read} onClick={() => void onFinding(finding.id, 'confirm', { proposalHash: proposal!.hash })}>Xác nhận finding và regression</button>}
      {!finding.confirmed && !ready && <button className="button small" disabled={busy || !open} onClick={() => setModal('manual')}>Xác nhận bằng review thủ công…</button>}
      {finding.reproduction && <button className="button small" disabled={busy || !open || !detail.run.checkpoint} title="Chạy lại kịch bản trên checkpoint hiện tại. Không gọi AI." onClick={() => void onFinding(finding.id, 'replay', proposal ? { proposalHash: proposal.hash } : {})}>Chạy lại phản ví dụ</button>}
      <button className="button small" disabled={busy} onClick={onDispute}>Bác bỏ</button>
      <button className="text-button" disabled={busy || !open} onClick={() => setModal('resolve')}>Đóng bằng review thủ công…</button>
    </div>}
    {modal === 'manual' && <ReasonModal title="Xác nhận bằng review thủ công" description="Chưa có test regression tự động cho finding này. Ghi bạn đã kiểm tra gì và vì sao tin nó đúng; lý do được lưu cùng finding." busy={busy} onClose={() => setModal(null)} onSave={async reason => { await onFinding(finding.id, 'confirm', { manualReason: reason }); setModal(null); }}/>}
    {modal === 'resolve' && <ReasonModal title="Đóng finding bằng review thủ công" description="Đây không phải bằng chứng đã sửa do runner xác minh; báo cáo sẽ ghi rõ như vậy cùng lý do của bạn." busy={busy} onClose={() => setModal(null)} onSave={async reason => { await onFinding(finding.id, 'resolve', { reason }); setModal(null); }}/>}
  </div>;
}

/** Each finding on the ladder from suspected to proven fixed. */
export function FindingProofList({ proofs }: { proofs?: FindingProof[] }) {
  if (!proofs?.length) return null;
  return <section className="panel" aria-label="Bằng chứng sửa finding">
    <h2>Finding: từ nghi ngờ đến chứng minh</h2>
    <p className="small muted">Chỉ mục “Đã chứng minh sửa xong” là runner đã thấy cùng kịch bản thất bại trước khi sửa và đạt sau khi sửa. Quyết định thủ công được ghi riêng.</p>
    <table className="compact"><thead><tr><th>Finding</th><th>Mức bằng chứng</th><th>Phản ví dụ trước → sau</th><th>Regression</th><th>Ghi chú</th></tr></thead><tbody>
      {proofs.map(p => <tr key={p.findingId}>
        <td>{p.title} <Badge tone="neutral" plain>{p.severity}</Badge></td>
        <td><Badge tone={LEVEL[p.level].tone}>{LEVEL[p.level].label}</Badge></td>
        <td className="mono small">{p.replayBefore ?? '—'} → {p.replayAfter ?? '—'}</td>
        <td className="small">{p.regression ?? '—'}{p.regressionBefore && <> ({p.regressionBefore} → {p.regressionAfter ?? '?'})</>}{p.regressionTestId && <small className="cell-note">{p.regressionTestId}</small>}</td>
        <td className="small muted">{p.note}</td></tr>)}
    </tbody></table>
  </section>;
}
