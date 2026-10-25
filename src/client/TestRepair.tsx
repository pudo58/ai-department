import { useEffect, useState } from 'react';
import type { PendingTestRepair } from '../core/recovery.js';

/** Approval is for this exact diff, not permission for an agent to rewrite locked tests later. */
export function TestRepairPanel({ proposal, busy, onApprove, onReject }: { proposal: PendingTestRepair; busy: boolean; onApprove: () => Promise<void>; onReject?: () => Promise<void> }) {
  const [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => { setAcknowledged(false); }, [proposal.hash]);
  return <section className="panel" aria-label="Đề xuất sửa test">
    <h2>Đề xuất sửa {proposal.kind === 'assertion' ? 'assertion' : 'setup'} test</h2>
    <p>{proposal.reason}</p><p><strong>Bằng chứng:</strong> {proposal.evidence}</p>
    {proposal.assessment&&<div className="notice-line"><p><strong>Theo hợp đồng:</strong> {proposal.assessment.expected}</p><p><strong>Runner quan sát:</strong> {proposal.assessment.actual}</p><p>Đích sửa: {proposal.assessment.target} · Test phù hợp hợp đồng: {proposal.assessment.testConformsToContract===null?'chưa rõ':proposal.assessment.testConformsToContract?'có':'không'} · {proposal.assessment.location}</p></div>}
    {proposal.assertionChanges?.map((change, i) => <article key={i}><strong>{change.caseId}: assertion</strong><p>Trước: {change.before}</p><p>Sau: {change.after}</p>{change.oracle.references.map((ref, n) => <p key={n}><code>{ref.requirementId}</code>: {ref.quote}</p>)}<p>{change.oracle.explanation}</p></article>)}
    <p>Ca liên quan: {proposal.caseIds.join(', ')}. Bộ test hiện tại vẫn đang bị khóa. Sau khi duyệt, hệ thống khóa lại bản sửa rồi chạy checks, mutation và Verifier trên checkpoint mới.</p>
    <details><summary>Đọc diff sửa test</summary><pre>{proposal.patch}</pre></details>
    <label><input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)}/> Tôi đã đọc diff và xác nhận bản sửa giữ nguyên hành vi cần kiểm chứng, không bỏ hoặc làm yếu assertion.</label>
    <button className="button primary" disabled={busy || !acknowledged} onClick={() => void onApprove()}>Duyệt bản sửa test và kiểm tra lại</button>
    {onReject && <button className="button" disabled={busy} onClick={() => void onReject()}>Không duyệt, giữ nguyên test</button>}
  </section>;
}
