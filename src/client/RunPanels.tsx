import { TestPlanView, QualityResults } from './Quality';
import { useMemo, useState } from 'react';
import type { Artifact, Attempt, CheckResult, ContractApprovalInput, Finding, HumanTime, Mode, Run, RunDetail } from '../shared/types';
import { CHECK_LABEL, CHECK_TONE, MODE_LABEL, ROW_LABEL, ROW_TONE, STEPS, TIME_CATEGORIES, pipelineStep } from './labels';
import { delivered } from '../core/delivery';
import { LogConsole } from './Monitor';
import { readVerdict } from '../core/report';
import {FindingReplayResults} from './FindingReplays';
import { FindingActions, FindingProofList } from './FindingEvidence';
import { policyOf } from '../core/policy';
import { Badge, DiffView, Empty, Field, Icon, Modal, dateTime, duration, money } from './ui';

/** Where the task is: four numbered steps on one strip, done ones ticked, the current one ringed. */
export function Stepper({ run }: { run: Run }) {
  const { index, kind } = pipelineStep({ ...run, deliveryStatus: delivered(run) ? 'succeeded' : 'unconfirmed', contractApproved: !!run.contract.approvedHash });
  const mark = { running: String(index + 1), attention: '!', bad: '×', idle: String(index + 1) }[kind];
  return <ol className="progress-line" aria-label="Tiến độ">{STEPS.map((label, i) => {
    const state = i < index ? 'done' : i === index ? `current ${kind}` : 'todo';
    return <li key={label} className={state} aria-current={i === index ? 'step' : undefined}>
      <span className="pl-step"><span className="pl-mark" aria-hidden="true">{i < index ? '✓' : i === index ? mark : i + 1}</span>{label}</span>
    </li>;
  })}</ol>;
}

/**
 * The agent tried to change files outside the project's allowed modules. Nothing is pre-selected: allowing a
 * path is a decision for this task only, and protected files never appear here because they cannot be allowed.
 */
export function ScopeApproval({ paths, approved, busy, onApprove }: { paths: string[]; approved: string[]; busy: boolean; onApprove: (selected: string[]) => Promise<void> }) {
  const groups = useMemo(() => {
    const byTop = new Map<string, string[]>();
    for (const p of paths) { const top = p.includes('/') ? p.split('/')[0]! : p; byTop.set(top, [...(byTop.get(top) ?? []), p]); }
    return [...byTop];
  }, [paths]);
  const [chosen, setChosen] = useState<string[]>([]);
  const toggle = (g: string) => setChosen((c) => (c.includes(g) ? c.filter((x) => x !== g) : [...c, g]));
  return <section className="scope-card" aria-label="Duyệt đường dẫn ngoài phạm vi">
    <h3>Agent muốn sửa file ngoài phạm vi cho phép</h3>
    <p className="small">Các file này nằm ngoài module của project nên patch đã bị từ chối và hoàn nguyên. Chọn thư mục hoặc file bạn đồng ý cho agent sửa <strong>trong task này</strong>, hệ thống sẽ chạy lại. File được bảo vệ (lockfile, config check, test đã khóa) không bao giờ được cho phép.{approved.length > 0 && <> Đã cho phép trước đó: <code>{approved.join(', ')}</code>.</>}</p>
    <ul className="scope-list">{groups.map(([top, files]) => <li key={top}>
      <label><input type="checkbox" checked={chosen.includes(top)} onChange={() => toggle(top)}/> <code>{files.length === 1 && files[0] === top ? top : `${top}/`}</code> <span className="muted small">{files.length > 1 || files[0] !== top ? `${files.length} file: ${files.slice(0, 4).map((f) => f.slice(top.length + 1)).join(', ')}${files.length > 4 ? '…' : ''}` : ''}</span></label>
    </li>)}</ul>
    <div className="row-actions" style={{ margin: 0 }}>
      <button className="button primary" disabled={busy || !chosen.length} onClick={() => void onApprove(chosen)}>Cho phép {chosen.length || ''} mục và chạy tiếp</button>
      <button className="text-button" onClick={() => setChosen(chosen.length === groups.length ? [] : groups.map(([g]) => g))}>{chosen.length === groups.length ? 'Bỏ chọn' : 'Chọn tất cả'}</button>
    </div>
  </section>;
}

export function ReasonModal({ title, description, onClose, onSave, busy }: { title: string; description: string; onClose: () => void; onSave: (reason: string) => Promise<void>; busy: boolean }) {
  const [reason, setReason] = useState('');
  return <Modal title={title} subtitle={description} onClose={onClose}><form onSubmit={(e) => { e.preventDefault(); void onSave(reason); }}>
    <Field label="Lý do"><textarea autoFocus required minLength={3} rows={4} value={reason} onChange={(e) => setReason(e.target.value)}/></Field>
    <div className="modal-footer"><button type="button" className="button" onClick={onClose}>Hủy</button><button className="button primary" disabled={busy}>Xác nhận</button></div>
  </form></Modal>;
}

export function EscalateModal({ run, onClose, onSave, busy }: { run: Run; onClose: () => void; onSave: (body: unknown) => Promise<void>; busy: boolean }) {
  const options = (['single', 'clarify', 'verify', 'compare'] as Mode[]).filter((m) => m !== run.mode);
  const [mode, setMode] = useState<Mode>(options[0]!);
  const [reason, setReason] = useState('');
  const [cap, setCap] = useState(run.budgetUsd);
  const ceiling = run.baseBudgetUsd * 3;
  return <Modal title="Chuyển chế độ" subtitle="Lịch sử và chi phí được giữ nguyên; chỉ chuyển khi có ngân sách thật để thực hiện." onClose={onClose}><form onSubmit={(e) => { e.preventDefault(); void onSave({ mode, reason, budgetUsd: cap }); }}>
    <Field label="Chế độ mới"><select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>{options.map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}</select></Field>
    <Field label="Tổng ngân sách task (USD)" hint={`Trần Team: ${money(ceiling)} (3× Single ${money(run.baseBudgetUsd)}). Tăng ngân sách là quyết định của bạn.`}><input type="number" min="0.01" step="0.01" max={ceiling} value={cap} onChange={(e) => setCap(Number(e.target.value))}/></Field>
    <Field label="Lý do"><textarea required minLength={3} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ví dụ: hai lượt sửa không tiến triển, hướng hiện tại bế tắc"/></Field>
    <div className="modal-footer"><button type="button" className="button" onClick={onClose}>Hủy</button><button className="button primary" disabled={busy}>Chuyển chế độ</button></div>
  </form></Modal>;
}

/** Live console and the event timeline are two views of the same story, so they share one tab. */
export function ProgressPanel({ detail }: { detail: RunDetail }) {
  const [view, setView] = useState<'log' | 'events'>('log');
  const tone = (type: string) => (/fail|reject|blocked/.test(type) ? 'bad' : /warn|quota|scope|empty|stop|recovery/.test(type) ? 'warn' : /accepted|approved|done|deliver\b/.test(type) ? 'good' : '');
  return <>
    <div className="row-actions" style={{ marginTop: 0 }}><div className="segmented" role="group" aria-label="Kiểu hiển thị">
      <button className={view === 'log' ? 'active' : ''} onClick={() => setView('log')}>Log trực tiếp</button>
      <button className={view === 'events' ? 'active' : ''} onClick={() => setView('events')}>Sự kiện <span className="n">{detail.events.length}</span></button></div></div>
    {view === 'log' ? <LogConsole runId={detail.run.id} height={440}/>
      : !detail.events.length ? <Empty title="Chưa có sự kiện">Nhấn Bắt đầu để chạy task.</Empty>
      : <ol className="timeline">{[...detail.events].reverse().map((e) => <li key={e.id} className={tone(e.type)}><time>{dateTime(e.createdAt)}</time><span className="msg"><code>{e.type}</code>{e.message}</span></li>)}</ol>}
  </>;
}

export function ContractPanel({ detail, busy = false, onApprove }: { detail: RunDetail; busy?: boolean; onApprove?: (input: ContractApprovalInput) => Promise<void> }) {
  const { run } = detail;
  const review = detail.contractReview;
  const [acknowledged, setAcknowledged] = useState('');
  const reviewKey = `${run.id}:${review.contractHash}`;
  const ack = acknowledged === reviewKey;
  const problems = review.problems;
  const receipt = run.contractReviewReceipt;
  const currentReceipt = receipt?.contractHash === review.contractHash && receipt.contractVersion === review.contractVersion ? receipt : undefined;
  const list = (title: string, items: string[]) => items.length ? <><h3>{title}</h3><ul className="plain-list">{items.map((i) => <li key={i}>{i}</li>)}</ul></> : null;
  return <div className="stack">
    <section className="panel"><h2>Yêu cầu gốc</h2><p style={{ whiteSpace: 'pre-wrap' }}>{run.originalRequirement}</p></section>
    <div className="panel">
    <div className="card-head"><h2>Hợp đồng v{run.contract.version}</h2><Badge tone={run.contract.approvedHash ? 'good' : 'warn'}>{run.contract.approvedHash ? 'Đã duyệt' : 'Chưa duyệt'}</Badge></div>
    <table className="compact" style={{ marginTop: 12 }}><thead><tr><th>Mã</th><th>Tiêu chí</th><th>Hành vi</th><th>Kiểm tra</th></tr></thead><tbody>{run.contract.requirements.map((r) => <tr key={r.id}><td><code>{r.id}</code></td><td>{r.text}</td><td>{r.kind === 'forbidden' ? 'Không được xảy ra' : 'Mong muốn'}</td><td>{r.required ? 'Bắt buộc' : 'Tùy chọn'}{r.manual ? ' · thủ công' : ''}</td></tr>)}</tbody></table>
    {list('Ví dụ nghiệm thu', run.contract.acceptanceExamples)}{list('Interface', run.contract.interfaces)}{list('Giả định cần xác nhận', run.contract.assumptions)}{list('Phạm vi', run.contract.scope)}
    <h3>Kế hoạch ca kiểm thử</h3>
    {detail.planReview && <div className={`banner ${detail.planReview.outcome === 'valid' ? 'info' : 'warn'}`} aria-label="Soát kế hoạch ca"><div>
      <strong>{detail.planReview.firstPassValid ? 'Kế hoạch hợp lệ ngay lượt đầu' : detail.planReview.repairAccepted ? 'Author đã sửa kế hoạch hợp lệ' : 'Kế hoạch cần bạn xem và sửa'}</strong>
      <p>{detail.planReview.attemptIds.length} lượt lập kế hoạch · {detail.planReview.repairAttempted ? 'Đã dùng một lượt sửa theo validator.' : 'Chưa dùng lượt sửa.'} {detail.planReview.reason === 'budget_exhausted' ? 'Ngân sách chuẩn bị không còn đủ để mở lượt sửa.' : detail.planReview.reason === 'questions_only' ? 'Cần làm rõ câu hỏi trước khi duyệt.' : ''}</p>
      <p className="small">Hợp lệ theo validator chỉ xác nhận cấu trúc và liên kết; bạn vẫn cần duyệt nội dung nghiệp vụ.</p>
      {!!detail.planReview.normalizations?.length && <details><summary>Server đã chuẩn hoá ({detail.planReview.normalizations.length})</summary><ul>{detail.planReview.normalizations.map((p, i) => <li key={i}>{p}</li>)}</ul></details>}
      {!!detail.planReview.remainingAdvisories?.length && <details><summary>Lưu ý về hình thức, không chặn duyệt ({detail.planReview.remainingAdvisories.length})</summary><ul>{detail.planReview.remainingAdvisories.map((p, i) => <li key={i}>{p}</li>)}</ul></details>}
      {detail.planReview.initialProblems.length > 0 && <details><summary>Lỗi bản nháp đầu ({detail.planReview.initialProblems.length})</summary><ul>{detail.planReview.initialProblems.map((p, i) => <li key={i}>{p}</li>)}</ul></details>}
    </div></div>}
    <TestPlanView plan={run.contract.testPlan}/>{detail.artifacts.filter(a => a.title === 'Test plan validation error' && (a.contractVersion === run.contract.version || !!a.attemptId && detail.planReview?.attemptIds.includes(a.attemptId))).map(a => <details key={a.id}><summary>Lỗi kế hoạch và output Author</summary><pre>{a.content}</pre></details>)}
    {!detail.quality.enabled && <p className="muted small">Chưa áp dụng kiểm thử sâu cho run này.</p>}
    {run.interpretations.length > 0 && <><h3>Các cách hiểu độc lập</h3><p className="muted small">Mỗi bản được lưu trước khi thấy hợp đồng hoặc kết luận của agent khác. Chỉ cần đọc phần khác biệt có ảnh hưởng hành vi.</p>
      <div className="card-grid">{run.interpretations.map((i) => <article className="card" key={i.id}><div className="card-head"><h3 style={{ margin: 0 }}>{i.role}</h3><Badge tone={i.contractSeen ? 'warn' : 'good'}>{i.contractSeen ? 'Đã thấy hợp đồng' : 'Độc lập'}</Badge></div><p>{i.text}</p>{i.questions.length > 0 && <ul className="plain-list">{i.questions.map((q) => <li key={q}>{q}</li>)}</ul>}</article>)}</div></>}
    </div>
    <section className="panel" aria-label="Soát hợp đồng">
      <h2>Soát hợp đồng trước khi chạy</h2>
      <p className="muted small">Đối chiếu với yêu cầu gốc trước khi duyệt. Kiểm tra này chỉ chỉ ra cấu trúc còn thiếu; không chứng minh hợp đồng đúng hoặc đầy đủ về nghiệp vụ.</p>
      {problems.length > 0 && <div className="banner error" role="alert"><ul>{problems.map((message) => <li key={message}>{message}</li>)}</ul></div>}
      {review.warnings.length > 0 ? <ul className="warnlist">{review.warnings.map((warning, index) => <li className="warn" key={`${warning.code}:${index}`}><span>{warning.message}</span></li>)}</ul> : <p className="muted small">Không có cảnh báo cấu trúc.</p>}
      {run.status === 'awaiting_approval' && onApprove ? <div className="stack" style={{ marginTop: 12 }}>
        {review.warnings.length > 0 && <label className="ack"><input type="checkbox" checked={ack} disabled={busy} onChange={(e) => setAcknowledged(e.target.checked ? reviewKey : '')}/>Tôi đã đọc các cảnh báo và đồng ý dùng hợp đồng này</label>}
        <div><button className="button primary" disabled={busy || problems.length > 0 || (review.warnings.length > 0 && !ack)} onClick={() => void onApprove({ contractHash: review.contractHash, acknowledgeWarnings: ack })}>Duyệt hợp đồng v{review.contractVersion}</button></div>
      </div> : currentReceipt ? <p className="muted small">Đã soát và duyệt bản hợp đồng này lúc {dateTime(currentReceipt.reviewedAt)}; đã xác nhận {currentReceipt.acknowledgedWarnings.length} cảnh báo.</p>
        : run.contract.approvedHash ? <p className="muted small">Giữ nguyên lịch sử phê duyệt cũ; chưa có bản ghi soát hợp đồng cho lần duyệt đó.</p> : null}
    </section>
  </div>;
}

/** Requirement matrix, system-run checks and verifier findings: everything that decides "is it really done". */
export function VerifyPanel({ detail, busy, onQuarantine, onFinding }: { detail: RunDetail; busy: boolean; onQuarantine: (id: string, reason: string) => Promise<void>; onFinding: (id: string, action: 'confirm' | 'resolve' | 'dispute' | 'replay', body?: unknown) => Promise<void> }) {
  const [target, setTarget] = useState<CheckResult | null>(null);
  const [disputing, setDisputing] = useState<Finding | null>(null);
  const checks = [...detail.checks].reverse();
  const verdict = readVerdict(detail.artifacts, detail.run);
  const tone = { blocker: 'bad', major: 'warn', minor: 'neutral' } as const;
  return <div className="stack">
    <FindingReplayResults replays={detail.findingReplays} checkpoint={detail.run.checkpoint}/>
    <FindingProofList proofs={detail.findingProofs}/>
    <div className="panel">
      <div className="card-head"><h2>Điều kiện nghiệm thu</h2><Badge tone={detail.completion.ready ? 'good' : 'warn'}>{detail.completion.ready ? 'Đủ điều kiện' : 'Chưa đủ'}</Badge></div>
      {detail.completion.reasons.length > 0 && <ul className="plain-list warn-list">{detail.completion.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
      <h3>Ma trận yêu cầu – bằng chứng</h3>
      <table className="compact"><thead><tr><th>Yêu cầu</th><th>Trạng thái</th><th>Bằng chứng (đúng checkpoint và phiên bản hợp đồng)</th></tr></thead><tbody>{detail.matrix.map((r) => <tr key={r.requirementId}><td><code>{r.requirementId}</code> {r.text.slice(0, 110)}{r.kind === 'forbidden' && <Badge tone="warn" plain>Không được xảy ra</Badge>}</td><td><Badge tone={ROW_TONE[r.status]}>{ROW_LABEL[r.status]}</Badge></td><td className="muted">{r.evidence.join(', ') || '—'}</td></tr>)}</tbody></table>
      <QualityResults quality={detail.quality}/>
      <h3>Check do hệ thống chạy</h3>
      {!checks.length ? <p className="muted small">Chưa có check nào.</p> : <table className="compact"><thead><tr><th>Check</th><th>Kết quả</th><th>Checkpoint</th><th>Lần chạy</th><th/></tr></thead><tbody>{checks.map((c) => <tr key={c.id} className={c.valid ? '' : 'stale'}>
        <td>{c.recipeId}{!c.valid && <small className="cell-note">hết hiệu lực (hợp đồng đã đổi)</small>}</td>
        <td><Badge tone={CHECK_TONE[c.status]}>{CHECK_LABEL[c.status]}</Badge>{c.quarantined && <Badge tone="neutral" plain>quarantine</Badge>}{c.quarantineReason && <small className="cell-note">{c.quarantineReason}</small>}</td>
        <td className="mono">{c.checkpoint.slice(0, 10)}{c.issues?.map((issue, i) => <small className="cell-note" key={i}>{issue.kind}: {issue.message}</small>)}</td><td className="mono">{c.attempts.map((a) => a.exitCode ?? '—').join(' → ')}</td>
        <td className="num">{c.status === 'flaky' && !c.quarantined && <button className="text-button" onClick={() => setTarget(c)}>Quarantine…</button>}</td></tr>)}</tbody></table>}
    </div>
    <div className="panel">
      <div className="card-head"><h2>Findings của Verifier</h2>{detail.findings.length > 0 && <span className="muted small">{detail.findings.length} finding</span>}</div>
      {verdict && <div style={{ marginTop: 8 }}>
        <Badge tone={verdict.decision === 'pass' ? 'good' : verdict.decision === 'block' ? 'bad' : 'warn'}>Kết luận: {verdict.decision === 'abstain' ? 'từ chối kết luận (abstain)' : verdict.decision}</Badge>
        {verdict.summary && <blockquote className="quote">{verdict.summary}</blockquote>}</div>}
      {!detail.findings.length ? <p className="muted small" style={{ marginBottom: 0 }}>{detail.run.mode === 'single' || detail.run.mode === 'clarify' ? 'Chế độ này không có Verifier độc lập.' : 'Verifier chưa phát hiện gì hoặc chưa chạy.'}</p> : <>
        <p className="muted small">Finding chỉ chặn khi blocker/major và chưa xử lý. Finding chưa xác nhận là tư vấn: xác nhận để mở một vòng sửa, hoặc bác bỏ nếu sai.</p>
        {detail.findings.map((f) => <article className={`finding ${f.status}`} key={f.id}>
          <div className="card-head"><h3 style={{ margin: 0 }}>{f.title}</h3><div><Badge tone={tone[f.severity]}>{f.severity}</Badge><Badge tone="neutral" plain>{f.category}{f.code ? ` · ${f.code}` : ''}</Badge>{f.confirmed && <Badge tone="good">đã xác nhận</Badge>}<Badge tone={f.status === 'resolved' ? 'good' : f.status === 'disputed' ? 'warn' : 'neutral'} plain>{f.status}</Badge></div></div>
          <dl className="facts"><dt>Vị trí</dt><dd className="mono">{f.location || '—'}</dd>{(f.rule || f.precedent) && <><dt>Rule / tiền lệ</dt><dd>{f.rule ?? f.precedent}</dd></>}<dt>Bằng chứng</dt><dd>{f.evidence || '—'}</dd><dt>Sửa tối thiểu</dt><dd>{f.suggestion || '—'}</dd>{f.dispute && <><dt>Ghi chú</dt><dd>{f.dispute}</dd></>}</dl>
          {policyOf(detail.run).strict ? <FindingActions detail={detail} finding={f} busy={busy} onFinding={onFinding} onDispute={() => setDisputing(f)}/> : f.status !== 'resolved' && <div className="row-actions" style={{ marginBottom: 0 }}>{!f.confirmed && <button className="button small" disabled={busy} onClick={() => void onFinding(f.id, 'confirm')}>Xác nhận</button>}<button className="button small" disabled={busy} onClick={() => setDisputing(f)}>Bác bỏ</button><button className="text-button" disabled={busy} onClick={() => void onFinding(f.id, 'resolve')}>Đánh dấu đã xử lý</button></div>}
        </article>)}</>}
    </div>
    {target && <ReasonModal title={`Quarantine "${target.recipeId}"`} description="Cần lý do và điều kiện xem xét lại. Check flaky không bao giờ được tính là bằng chứng cho yêu cầu." busy={false} onClose={() => setTarget(null)} onSave={async (reason) => { await onQuarantine(target.id, reason); setTarget(null); }}/>}
    {disputing && <ReasonModal title="Bác bỏ finding" description="Lý do được lưu cùng finding để đo tỷ lệ báo động giả." busy={busy} onClose={() => setDisputing(null)} onSave={async (reason) => { await onFinding(disputing.id, 'dispute', { reason }); setDisputing(null); }}/>}
  </div>;
}

export function CodePanel({ detail }: { detail: RunDetail }) {
  const diffs = detail.artifacts.filter((a) => a.kind === 'diff');
  const [selected, setSelected] = useState<string>('');
  const current: Artifact | undefined = diffs.find((d) => d.id === selected) ?? diffs[diffs.length - 1];
  const reuse = detail.artifacts.filter((a) => a.kind === 'reuse' && a.valid).at(-1);
  const tools = detail.artifacts.filter((a) => a.kind === 'tool' && a.valid);
  const parsedReuse = useMemo(() => { try { return reuse ? (JSON.parse(reuse.content) as { reuse: { path: string; fit: string; decision: string; reason: string }[] }).reuse : []; } catch { return []; } }, [reuse]);
  return <div className="stack">
    <div className="panel">
      <div className="card-head"><h2>Diff</h2>{diffs.length > 0 && <select aria-label="Chọn diff" style={{ width: 'auto', maxWidth: 360 }} value={current?.id} onChange={(e) => setSelected(e.target.value)}>{diffs.map((d) => <option key={d.id} value={d.id}>{d.title}{d.valid ? '' : ' (bị từ chối / hết hiệu lực)'}</option>)}</select>}</div>
      {!diffs.length ? <p className="muted small">Chưa có diff.</p> : <DiffView text={current?.content ?? ''}/>}
    </div>
    <div className="section-split">
      <div className="panel"><h2>Tái sử dụng</h2><p className="muted small" style={{ marginTop: 2 }}>ReuseAssessment do Developer báo cáo.</p>
        {!parsedReuse.length ? <p className="muted small">Chưa có đánh giá hợp lệ.</p> : <table className="compact"><thead><tr><th>Đường dẫn</th><th>Quyết định</th><th>Lý do</th></tr></thead><tbody>{parsedReuse.map((r, i) => <tr key={i}><td className="mono">{r.path}</td><td>{r.decision} <span className="faint">({r.fit})</span></td><td className="muted">{r.reason}</td></tr>)}</tbody></table>}</div>
      <div className="panel"><h2>Phân tích công cụ</h2><p className="muted small" style={{ marginTop: 2 }}>Công cụ lỗi hoặc chưa cấu hình được báo là "chưa phân tích", không phải sạch.</p>
        {!tools.length ? <p className="muted small">Chưa có.</p> : tools.map((t) => <div key={t.id}><strong className="small">{t.title}</strong><ul className="plain-list">{(JSON.parse(t.content) as { tool: string; status: string; newIssues: string[]; reason?: string }[]).map((d) => <li key={d.tool}><code>{d.tool}</code>: {d.status === 'ok' ? `${d.newIssues.length} vấn đề mới` : <em>chưa phân tích — {d.reason}</em>}</li>)}</ul></div>)}</div>
    </div>
    <div className="panel"><h2>Các lượt agent</h2>
      <table className="compact" style={{ marginTop: 10 }}><thead><tr><th>Vai</th><th>Phương án</th><th>Giai đoạn</th><th>Model</th><th>Độc lập</th><th>Ngữ cảnh</th><th>Trạng thái</th></tr></thead><tbody>{detail.attempts.map((a: Attempt) => <tr key={a.id}><td>{a.role}</td><td>{a.slot}</td><td>{a.stage}</td><td className="mono">{a.model}</td><td>{a.independence ? <span title={a.independence.reason}><Badge tone={a.independence.independent ? 'good' : 'warn'}>{a.independence.independent ? 'Độc lập' : 'Giảm độc lập'}</Badge></span> : <span className="faint">—</span>}</td><td className="context-cell"><ContextCell artifact={detail.artifacts.find((x) => x.kind === 'context' && x.attemptId === a.id && x.title.startsWith('Ngữ cảnh'))}/></td><td>{a.status}{a.error && <small className="cell-note">{a.error.slice(0, 120)}</small>}</td></tr>)}</tbody></table>
    </div>
  </div>;
}

export function CostPanel({ detail, onAct }: { detail: RunDetail; onAct: (path: string, body?: unknown) => Promise<void> }) {
  const { run, budget } = detail;
  const [category, setCategory] = useState<HumanTime['category']>('review');
  const [minutes, setMinutes] = useState(5);
  const open = run.humanTime.filter((t) => !t.endedAt);
  const closed = run.humanTime.filter((t) => t.endedAt);
  const phases = Object.entries(budget.phases) as [string, { allocatedUsd: number; spentUsd: number }][];
  return <div className="section-split">
    <div className="panel"><h2>Ngân sách theo giai đoạn</h2>
      {phases.map(([name, p]) => <div className="bar-row" key={name}><span>{name}</span><div className="bar"><div style={{ width: `${Math.min(100, p.allocatedUsd ? (p.spentUsd / p.allocatedUsd) * 100 : 0)}%` }} className={p.spentUsd > p.allocatedUsd ? 'over' : ''}/></div><small>{money(p.spentUsd)} / {money(p.allocatedUsd)}</small></div>)}
      {run.escalations.length > 0 && <><h3>Lịch sử chuyển chế độ</h3><ul className="plain-list">{run.escalations.map((e, i) => <li key={i}>{dateTime(e.at)}: {e.from} → {e.to} — {e.reason}</li>)}</ul></>}
      {run.followupUntil && <p className="notice" style={{ marginTop: 14 }}><Icon name="info" size={16}/><span>Cửa sổ theo dõi sau bàn giao đến {dateTime(run.followupUntil)}. Công sửa lỗi phát sinh hãy nhập ở loại "Sửa sau bàn giao".</span></p>}
    </div>
    <div className="panel"><h2>Công của bạn</h2>
      <p className="muted small" style={{ marginTop: 2 }}>Chỉ thời gian bạn bấm bắt đầu/dừng hoặc nhập tay mới được tính, không tính thời gian mở màn hình.</p>
      <div className="row-actions">
        <select aria-label="Loại công việc" value={category} onChange={(e) => setCategory(e.target.value as HumanTime['category'])}>{Object.entries(TIME_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <button className="button" onClick={() => void onAct(`/api/runs/${run.id}/time/start`, { category })}><Icon name="clock" size={14}/>Bắt đầu đếm</button>
      </div>
      <div className="row-actions" style={{ marginTop: 0 }}><input aria-label="Số phút" type="number" min="0" max="1440" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className="narrow"/><button className="button" onClick={() => void onAct(`/api/runs/${run.id}/time/manual`, { category, minutes })}>Nhập phút</button></div>
      {open.map((t) => <div key={t.id} className="banner info" style={{ marginTop: 10 }}><Icon name="clock" size={16}/><span>Đang đếm: {TIME_CATEGORIES[t.category]} từ {dateTime(t.startedAt)} <button className="text-button" onClick={() => void onAct(`/api/runs/${run.id}/time/${t.id}/stop`)}>Dừng</button></span></div>)}
      {closed.length > 0 && <table className="compact" style={{ marginTop: 12 }}><thead><tr><th>Loại</th><th>Thời lượng</th><th>Ghi chú</th></tr></thead><tbody>{closed.map((t) => <tr key={t.id}><td>{TIME_CATEGORIES[t.category]}</td><td>{duration(t.durationMs ?? 0)}</td><td className="muted">{t.note}</td></tr>)}</tbody></table>}
    </div>
  </div>;
}

/** What project context an attempt received, as recorded when its prompt was sent. */
export function ContextCell({ artifact }: { artifact?: Artifact }) {
  if (!artifact) return <span className="faint">—</span>;
  const c = JSON.parse(artifact.content) as { role: string | null; contextOn: boolean; usedTokens: number; memoryIds: string[]; sections: { name: string; text: string; included: boolean; tokens: number }[]; skills?: { name: string; delivery: string; hasScripts: boolean }[] };
  const sent = c.sections.filter((s) => s.included);
  // Skills are listed whether or not project context is on: they are a separate, per-role assignment.
  const skills = c.skills?.length ? <small className="muted" title={c.skills.map((s) => `${s.name}: ${s.delivery === 'plugin' ? 'plugin Claude' : s.delivery === 'workspace' ? '.agents/skills' : 'trong prompt'}`).join('\n')}>Skill: {c.skills.map((s) => s.name + (s.hasScripts ? ' (script)' : '')).join(', ')}</small> : null;
  if (!c.contextOn) return skills ?? <span className="faint">Tắt</span>;
  if (!sent.length) return skills ?? <span className="faint">Không gửi</span>;
  return <details><summary>~{c.usedTokens} token · {c.memoryIds.length} mục</summary>{skills}{sent.map((s, i) => <div key={i}><small className="muted">{s.name} (~{s.tokens})</small><pre className="detect-pre">{s.text}</pre></div>)}</details>;
}
