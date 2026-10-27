import { useCallback, useEffect, useState } from 'react';
import { TestRepairPanel } from './TestRepair.js';
import { ExecutionPanel } from './ExecutionPanel.js';
import type { Run, RunDetail } from '../shared/types';
import { delivered } from '../core/delivery';
import { humanizeTestIds } from '../core/testids';
import type { StepAction } from '../core/nextstep';
import { NextStepCard } from './NextStepCard';
import { api } from './api';
import { ContractForm } from './forms';
import { ACTIVE, MODE_LABEL, STATUS } from './labels';
import { PreviewButton } from './Preview';
import { LiveTests, ReviewPanel } from './ReviewPanel';
import { PROVIDER_LABEL } from '../shared/providers';
import { Badge, ConfirmDialog, Icon, Ledger, count, dateTime, duration, money } from './ui';
import { Stepper, ScopeApproval, ReasonModal, EscalateModal, ProgressPanel, ContractPanel, VerifyPanel, CodePanel, CostPanel } from './RunPanels';

type Tab = 'review' | 'progress' | 'contract' | 'verify' | 'code' | 'cost';

/** Confirms deleting one task; used from the task table and from the task page. */
export function DeleteRunDialog({ run, onClose, onDeleted }: { run: Pick<Run, 'id' | 'title' | 'status' | 'delivery'> & { deliveryStatus?: string }; onClose: () => void; onDeleted: () => Promise<void> }) {
  const working = ACTIVE.includes(run.status) || run.delivery?.status === 'in_progress' || run.deliveryStatus === 'in_progress';
  return <ConfirmDialog title="Xoá việc này?" confirmLabel="Xoá việc" disabled={working} onClose={onClose}
    onConfirm={async () => { await api(`/api/runs/${run.id}`, 'DELETE'); await onDeleted(); }}>
    <p className="confirm-subject">{run.title}</p>
    <p>Xoá lịch sử chạy, log, bằng chứng và bản sao làm việc của việc này. Không hoàn tác được.</p>
    {run.status === 'completed' && <p className="muted">Kiểm tra bằng chứng giao trong báo cáo trước khi xoá bản sao làm việc.</p>}
    {run.status === 'awaiting_acceptance' && <p className="notice-line warn">Kết quả đang chờ nghiệm thu sẽ mất.</p>}
    {working && <p className="notice-line warn">Việc đang chạy. Dừng nó trước rồi mới xoá được.</p>}
  </ConfirmDialog>;
}

export function RunPage({ id, onBack, onDeleted }: { id: string; onBack: () => void; onDeleted: () => Promise<void> }) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [tab, setTab] = useState<Tab>('progress');
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<'contract' | 'escalate' | 'reject' | 'delete' | null>(null);
  const [closing, setClosing] = useState<{ id: string; title: string } | null>(null);

  const refresh = useCallback(async () => { try { setDetail(await api<RunDetail>(`/api/runs/${id}`)); setLoadError(''); } catch (e) { setLoadError((e as Error).message); } }, [id]);
  const active = detail ? ACTIVE.includes(detail.run.status) : false;
  useEffect(() => { void refresh(); const t = setInterval(() => void refresh(), active ? 1500 : 4000); return () => clearInterval(t); }, [refresh, active]);
  // When a task reaches acceptance, open the report: that is what a person must read next.
  const runStatus = detail?.run.status;
  useEffect(() => { if (runStatus === 'awaiting_acceptance') setTab('review'); else if (runStatus === 'awaiting_approval') setTab('contract'); }, [runStatus]);

  async function act(path: string, body: unknown = {}) {
    setBusy(true); setError('');
    try { await api(path, 'POST', body); setModal(null); await refresh(); } catch (e) { await refresh(); setError((e as Error).message); } finally { setBusy(false); }
  }
  const crumbs = (title: string) => <nav className="crumbs" aria-label="Điều hướng"><button onClick={onBack}>Công việc</button><span>/</span><span>{title}</span></nav>;
  const pageError = error || loadError;
  if (!detail) return <>{crumbs('…')}{pageError ? <div className="banner error" role="alert">{pageError}</div> : <p className="muted">Đang tải…</p>}</>;

  const { run } = detail;
  const delivering = run.delivery?.status === 'in_progress';
  const locked = busy || delivering;
  // When "Chạy tiếp" cannot change anything the card says what to do instead, and the button stops inviting another press.
  const stuck = detail.nextStep?.resumeChanges === false;
  const onStep = (a: StepAction) => {
    if (a.id === 'resume') void act(`/api/runs/${id}/resume`);
    else if (a.id === 'recheck') void act(`/api/runs/${id}/recheck`, { refreshConfig: true });
    else if (a.id === 'revise_contract') setModal('contract');
    else if (a.id === 'switch_single') setModal('escalate');
    else if (a.id === 'review_findings') setTab('verify');
    else if (a.id === 'edit_project') window.location.hash = '#/projects';
    else if (a.id === 'close_finding' && a.findingId) setClosing({ id: a.findingId, title: detail.findings.find((f) => f.id === a.findingId)?.title ?? '' });
  };
  const status = delivering ? { label: 'Đang giao kết quả', tone: 'blue' }
    : run.delivery?.status === 'failed' ? { label: 'Chưa giao được kết quả', tone: 'red' }
    : run.delivery?.status === 'unknown' || (run.status === 'completed' && !delivered(run)) ? { label: 'Chưa xác nhận giao', tone: 'orange' } : STATUS[run.status];
  const confirmed = detail.findings.filter((f) => f.confirmed && f.status === 'open').length;
  const openSerious = detail.findings.filter((f) => f.status !== 'resolved' && (f.severity === 'blocker' || f.severity === 'major')).length;
  const aiTime = detail.attempts.reduce((n, a) => n + (a.endedAt ? Date.parse(a.endedAt) - Date.parse(a.startedAt) : 0), 0);
  const humanTime = run.humanTime.reduce((n, t) => n + (t.durationMs ?? 0), 0);
  const tokens = run.usage.reduce((n, u) => n + u.inputTokens + u.outputTokens, 0);
  const budgetPct = detail.budget.capUsd ? Math.min(100, (detail.budget.spentUsd / detail.budget.capUsd) * 100) : 0;
  const waiting = ['draft', 'paused', 'blocked', 'failed'].includes(run.status);

  const reviewable = run.status === 'awaiting_acceptance' || run.status === 'completed';
  const tabs: [Tab, string, ReactPill?][] = [
    ...(reviewable ? [['review', run.status === 'completed' ? 'Báo cáo nghiệm thu' : 'Nghiệm thu', run.status === 'awaiting_acceptance' ? { text: '!', alert: true } : undefined] as [Tab, string, ReactPill?]] : []),
    ['progress', 'Tiến trình'], ['contract', 'Hợp đồng', { text: `v${run.contract.version}` }],
    ['verify', 'Kiểm chứng', openSerious ? { text: String(openSerious), alert: true } : undefined], ['code', 'Mã nguồn'], ['cost', 'Chi phí & công'],
  ];
  return <>
    {crumbs(run.title)}
    <header className="dossier-head">
      <div className="dossier-title">
        <h1 title={run.title}>{run.title}</h1>
        {run.originalRequirement.trim() !== run.title.trim() && <p className="run-req" title={run.originalRequirement}>{run.originalRequirement}</p>}
        <dl className="props">
          <dt>Trạng thái</dt><dd><Badge tone={status.tone} live={ACTIVE.includes(run.status)}>{status.label}</Badge>{run.provider === 'fake' && <Badge tone="orange">Mô phỏng</Badge>}</dd>
          <dt>Dự án</dt><dd>{run.configSnapshot.name}</dd>
          <dt>Chế độ</dt><dd>{MODE_LABEL[run.mode]}{run.mode !== run.initialMode ? ` (từ ${MODE_LABEL[run.initialMode]})` : ''}</dd>
          <dt>AI phụ trách</dt><dd>{run.provider === 'fake' ? 'Mô phỏng' : PROVIDER_LABEL[run.configSnapshot.roles.developer.provider]}<span className="faint"> · {run.configSnapshot.roles.developer.model || 'model mặc định'}</span></dd>
          <dt>Giao lúc</dt><dd>{dateTime(run.createdAt)}</dd>
          <dt>Mã việc</dt><dd className="mono faint">{run.id}</dd>
        </dl>
      </div>
      <div className="action-bar" aria-label="Hành động">
        {waiting && !detail.testRepair && <button className={`button${stuck ? '' : ' primary'}`} disabled={busy || stuck} title={stuck ? 'Chạy tiếp sẽ không đổi kết quả. Hãy làm việc ở khung “Việc cần làm” bên dưới.' : undefined} onClick={() => void act(`/api/runs/${id}/${run.status === 'draft' ? 'start' : 'resume'}`)}>{run.status === 'draft' ? 'Bắt đầu' : 'Chạy tiếp'}</button>}
        {run.status === 'awaiting_approval' && <>
          <button className="button primary" disabled={locked} onClick={() => setTab('contract')}>Xem và duyệt hợp đồng</button>
          <button className="button" onClick={() => setModal('contract')}>Sửa hợp đồng</button></>}
        {waiting && run.status !== 'draft' && <button className="button" disabled={locked} onClick={() => setModal('contract')}>Sửa hợp đồng</button>}
        {active && <button className="button" disabled={busy} onClick={() => void act(`/api/runs/${id}/stop`)}>Dừng</button>}
        {run.status === 'awaiting_acceptance' && <>
          <button className="button primary" disabled={locked || !detail.completion.ready} onClick={() => setTab('review')}>Xem báo cáo và nghiệm thu</button>
          <button className="button" disabled={locked} onClick={() => setModal('reject')}>Từ chối</button></>}
        {confirmed > 0 && ['blocked', 'awaiting_acceptance'].includes(run.status) && <button className="button" disabled={locked} onClick={() => void act(`/api/runs/${id}/repair`)}>Sửa {confirmed} finding đã xác nhận</button>}
        {(waiting || run.status === 'awaiting_acceptance') && run.status !== 'draft' && run.checkpoint && run.mode !== 'compare' && <button className="button" disabled={busy} title="Chạy lại test trên bản đã làm xong, dùng cấu hình project mới nhất. Không gọi agent nên không tốn token." onClick={() => void act(`/api/runs/${id}/recheck`, { refreshConfig: true })}>Chạy lại check</button>}
        {(waiting || run.status === 'awaiting_acceptance') && run.status !== 'draft' && <button className="button ghost" disabled={locked} onClick={() => setModal('escalate')}>Chuyển chế độ</button>}
        {run.checkpoint && run.provider !== 'fake' && !active && !delivering && run.status !== 'queued' && <PreviewButton runId={id}/>}
        {!active && <button className="button ghost danger-ghost" disabled={locked} onClick={() => setModal('delete')} title="Xoá việc này"><Icon name="trash" size={14}/>Xoá</button>}
      </div>
    </header>

    <Stepper run={run}/>
    <Ledger items={[
      { label: 'Chi phí', value: money(detail.budget.spentUsd), sub: `trên ${money(detail.budget.capUsd)} · ${Math.round(budgetPct)}% ngân sách`, tone: detail.budget.spentUsd > detail.budget.capUsd ? 'warn' : undefined },
      { label: 'Token', value: count(tokens), sub: detail.budget.estimated ? 'gồm phần ước tính' : 'theo báo cáo của AI' },
      { label: 'Thời gian AI', value: duration(aiTime), sub: `${detail.attempts.length} lượt agent` },
      { label: 'Công của bạn', value: duration(humanTime), sub: `${run.repairCount} vòng sửa · dừng ${detail.stops ?? 0} lần` },
    ]}/>

    {pageError && <div className="banner error" role="alert"><span>{pageError}</span></div>}
    {detail.nextStep
      ? <NextStepCard step={detail.nextStep} busy={locked} onAction={onStep}/>
      : run.blocker && <div className="banner warn"><span><strong>Cần chú ý:</strong> {humanizeTestIds(run.blocker)}</span></div>}
    {detail.testRepair && <TestRepairPanel proposal={detail.testRepair} busy={locked || active || run.status === 'queued'} onApprove={() => act(`/api/runs/${id}/approve-test-repair`, { proposalId: detail.testRepair!.id, proposalHash: detail.testRepair!.hash })} onReject={() => act(`/api/runs/${id}/reject-test-repair`, { proposalId: detail.testRepair!.id, proposalHash: detail.testRepair!.hash })}/>}
    {detail.pendingPaths.length > 0 && <ScopeApproval paths={detail.pendingPaths} approved={run.approvedPaths ?? []} busy={busy} onApprove={(selected) => act(`/api/runs/${id}/approve-paths`, { paths: selected, resume: true })}/>}
    {run.mode === 'single' && run.recommendation.mode !== 'single' && <div className="notice"><span><strong>Gợi ý {MODE_LABEL[run.recommendation.mode]} (chi phí dự kiến ×{run.recommendation.multiplier}):</strong> {run.recommendation.reasons.join(' ')}</span></div>}

    {detail.runningCheck && <LiveTests detail={detail}/>}
    <ExecutionPanel detail={detail} busy={locked || active || run.status==='queued' || run.status==='completed'} onAct={act}/>

    <div className="dossier">
      <nav className="tabs dossier-toc" role="tablist" aria-label="Mục lục hồ sơ">{tabs.map(([key, label, pill]) => <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>{label}{pill && <span className={`pill${pill.alert ? ' alert' : ''}`}>{pill.text}</span>}</button>)}</nav>
      <div className="dossier-body">
        {tab === 'review' && reviewable && <ReviewPanel detail={detail} busy={locked} onAccept={(ack) => act(`/api/runs/${id}/accept`, { acknowledgeWarnings: ack })} onReject={() => setModal('reject')}/>}
        {tab === 'progress' && <ProgressPanel detail={detail}/>}
        {tab === 'contract' && <ContractPanel detail={detail} busy={locked} onApprove={(body) => act(`/api/runs/${id}/approve-contract`, body)}/>}
        {tab === 'verify' && <VerifyPanel detail={detail} busy={locked} onQuarantine={(checkId, reason) => act(`/api/runs/${id}/checks/${checkId}/quarantine`, { reason })} onFinding={(fid, action, body) => act(`/api/runs/${id}/findings/${fid}/${action}`, body ?? {})}/>}
        {tab === 'code' && <CodePanel detail={detail}/>}
        {tab === 'cost' && <CostPanel detail={detail} onAct={act}/>}
        {run.mode === 'single' && tab !== 'cost' && <p className="faint small dossier-note">Single: lập kế hoạch, viết test và tự soát đều do một agent làm. Đó là tự review, không phải kiểm chứng độc lập.</p>}
      </div>
    </div>

    {modal === 'contract' && <ContractForm run={run} busy={busy} onClose={() => setModal(null)} onSave={async (contract) => { const { version: _v, approvedHash: _h, approvedAt: _a, ...body } = contract; await act(`/api/runs/${id}/contract`, body); }}/>}
    {modal === 'reject' && <ReasonModal title="Từ chối nghiệm thu" description="Lý do được ghi lại; chi phí và công sửa vẫn thuộc task này." busy={busy} onClose={() => setModal(null)} onSave={(reason) => act(`/api/runs/${id}/reject`, { reason })}/>}
    {modal === 'escalate' && <EscalateModal run={run} busy={busy} onClose={() => setModal(null)} onSave={(body) => act(`/api/runs/${id}/escalate`, body)}/>}
    {closing && <ReasonModal title="Đóng phát hiện bằng review thủ công" description={`“${closing.title}”. Ghi bạn đã thử gì và thấy gì (ít nhất 10 ký tự). Báo cáo sẽ ghi đây là quyết định của bạn, không phải do máy chứng minh.`} minLength={10} suggestion="Đã thử trên app và thấy đúng: " busy={busy} onClose={() => setClosing(null)} onSave={async (reason) => { await act(`/api/runs/${id}/findings/${closing.id}/resolve`, { reason }); setClosing(null); }}/>}
    {modal === 'delete' && <DeleteRunDialog run={run} onClose={() => setModal(null)} onDeleted={onDeleted}/>}
  </>;
}
type ReactPill = { text: string; alert?: boolean };

// ------------------------------------------------------------------ panels

