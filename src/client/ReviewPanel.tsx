import { QualityResults } from './Quality';
import { VisualReview } from './VisualReview';
import {FindingReplayResults} from './FindingReplays';
import { FindingProofList } from './FindingEvidence';
import { useCallback, useEffect, useState } from 'react';
import type { AcceptanceReport } from '../core/report';
import { needsAcknowledgement } from '../core/report';
import { delivered } from '../core/delivery';
import { countTestLines, type LiveTally } from '../core/testlines';
import type { RunDetail } from '../shared/types';
import { api } from './api';
import { ROW_LABEL, ROW_TONE } from './labels';
import { LogConsole, useNow, type LogEntry } from './Monitor';
import { Badge, DiffView, Icon, count, dateTime, duration, money } from './ui';

const DECISION: Record<string, { label: string; tone: string }> = {
  pass: { label: 'Không phát hiện lỗi', tone: 'good' }, block: { label: 'Đề nghị chặn', tone: 'bad' }, abstain: { label: 'Từ chối kết luận', tone: 'warn' },
  skipped: { label: 'Bị bỏ qua', tone: 'warn' }, unparsed: { label: 'Không đọc được phản hồi', tone: 'warn' },
};
const KIND: Record<string, string> = { added: 'Mới', modified: 'Sửa', deleted: 'Xóa', renamed: 'Đổi tên' };

/** The test program while it runs: the command, how long, and each test as its result arrives. */
export function LiveTests({ detail }: { detail: RunDetail }) {
  const running = detail.runningCheck;
  const now = useNow(1000);
  const [tally, setTally] = useState<LiveTally>({ passed: 0, failed: 0, skipped: 0, finished: false });
  const runId = detail.run.id, since = running?.startedAt;
  useEffect(() => {
    if (!since) return;
    let alive = true;
    const tick = async () => {
      try {
        const rows = await api<LogEntry[]>(`/api/logs?run=${runId}&source=check&level=info&limit=1000`);
        if (alive) setTally(countTestLines(rows.filter((r) => r.ts >= since).map((r) => r.message)));
      } catch { /* the console below still shows the lines; the tally is only a convenience */ }
    };
    void tick();
    const timer = setInterval(() => void tick(), 1200);
    return () => { alive = false; clearInterval(timer); };
  }, [runId, since]);
  if (!running) return null;
  return <section className="livetests" aria-label="Chương trình test đang chạy">
    <div className="livetests-head">
      <span className="dot dot-live"/><strong>Chương trình test đang chạy</strong>
      <Badge tone="info" plain>{running.ref === 'base' ? 'trên mã gốc (kiểm tra test fail trước khi sửa)' : `check "${running.recipeId}"`}</Badge>
      <span className="mono small livetests-time">{duration(now - Date.parse(running.startedAt))}</span>
    </div>
    <code className="livetests-cmd">{running.command}</code>
    <div className="livetests-tally" aria-live="polite">
      <span className="tally pass"><Icon name="check" size={13}/>{tally.passed} pass</span>
      <span className={`tally fail${tally.failed ? ' on' : ''}`}><Icon name="close" size={13}/>{tally.failed} fail</span>
      <span className="tally skip">{tally.skipped} bỏ qua</span>
      <span className="faint small">{tally.passed + tally.failed + tally.skipped === 0 ? 'Chờ test đầu tiên hoàn tất…' : tally.finished ? 'Đang tổng hợp kết quả…' : 'đang chạy tiếp…'}</span>
    </div>
    <LogConsole runId={runId} source="check" compact height={200}/>
  </section>;
}

const Copy = ({ text }: { text: string }) => {
  const [done, setDone] = useState(false);
  return <button className="icon-button" title="Sao chép" aria-label="Sao chép lệnh" onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); }).catch(() => undefined); }}><Icon name={done ? 'check' : 'terminal'} size={14}/></button>;
};

/** Everything a person needs to decide on acceptance, in one place, with the decision at the bottom. */
export function ReviewPanel({ detail, busy, onAccept, onReject }: { detail: RunDetail; busy: boolean; onAccept: (acknowledgeWarnings: boolean) => Promise<void>; onReject: () => void }) {
  const { run } = detail;
  const [report, setReport] = useState<AcceptanceReport | null>(null);
  const [error, setError] = useState('');
  const [ack, setAck] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const load = useCallback(() => api<AcceptanceReport>(`/api/runs/${run.id}/report`).then((r) => { setReport(r); setError(''); }).catch((e: Error) => setError(e.message)), [run.id]);
  useEffect(() => { void load(); }, [load, run.checkpoint, run.contract.version, run.status, run.updatedAt, run.delivery?.status, run.delivery?.endedAt]);
  useEffect(() => { setAck(false); }, [run.checkpoint, run.contract.version]);
  if (error) return <div className="banner error" role="alert"><Icon name="alert" size={16}/><span>{error}</span></div>;
  if (!report) return <p className="muted">Đang lập báo cáo…</p>;

  const warns = report.warnings.filter((w) => w.level === 'warn');
  const infos = report.warnings.filter((w) => w.level === 'info');
  const needAck = needsAcknowledgement(report);
  const done = run.status === 'completed' && delivered(run);
  const delivering = run.delivery?.status === 'in_progress';
  const retry = run.delivery?.status === 'failed' || run.delivery?.status === 'unknown' || (run.status === 'completed' && !done);
  const verdictCls = report.readiness === 'ready' ? 'ok' : report.readiness === 'ready_with_warnings' ? 'warn' : 'bad';
  const title = { ready: 'Sẵn sàng nghiệm thu', ready_with_warnings: `Có ${warns.length} cảnh báo cần đọc trước khi nghiệm thu`, not_ready: 'Chưa đủ điều kiện nghiệm thu' }[report.readiness];

  return <div className="stack review">
    <QualityResults quality={report.quality}/>
    <FindingProofList proofs={report.findingProofs}/>
    <FindingReplayResults replays={report.findingReplays} checkpoint={run.checkpoint}/>
    {run.delivery?.status === 'failed' && <div className="banner error" role="alert"><span><strong>Chưa giao được kết quả</strong><br/>{run.delivery.error} Workspace được giữ để thử giao lại.</span></div>}
    {run.delivery?.status === 'unknown' && <div className="banner warn" role="alert"><span><strong>Chưa xác nhận giao kết quả</strong><br/>{run.delivery.error} Workspace được giữ để thử giao lại.</span></div>}
    {run.status === 'completed' && !done && <div className="banner warn" role="alert"><span><strong>Chưa xác nhận giao kết quả</strong><br/>Lịch sử nghiệm thu{run.acceptedAt ? ` lúc ${dateTime(run.acceptedAt)}` : ''} vẫn được giữ. Cần thử giao lại để xác nhận bản code này đã được giao.</span></div>}
    {delivering && <div className="banner warn" role="status">Đang giao kết quả…</div>}
    {report.degraded && <div className="banner warn" role="status"><span><strong>Chạy suy giảm</strong><br/>{report.degraded.items} bước được hệ thống tự xử lý thay vì dừng ({report.degraded.stages.join(', ')}). Bằng chứng yếu hơn một run sạch; đọc phần cảnh báo.</span></div>}
    <div className={`verdict ${verdictCls}`}>
      <div><span className="kicker">Kết luận của hệ thống</span><strong>{done ? 'Đã nghiệm thu' : title}</strong>
        <p>{report.readiness === 'not_ready' ? report.notReadyReasons.join(' ') : report.readiness === 'ready' ? 'Mọi điều kiện tự động đều đạt và không có điều gì cần xem lại.' : 'Mọi điều kiện tự động đều đạt, nhưng có điểm hệ thống không chứng minh được. Đọc phần cảnh báo bên dưới.'}</p></div>
      <a className="button" href={`/api/runs/${run.id}/report.md`} download>Tải báo cáo (.md)</a>
    </div>

    {report.warnings.length > 0 && <section className="panel">
      <h2>Cảnh báo và lưu ý</h2>
      <ul className="warnlist">
        {warns.map((w, i) => <li key={`w${i}`} className="warn"><span>{w.text}</span></li>)}
        {infos.map((w, i) => <li key={`i${i}`} className="info"><span>{w.text}</span></li>)}
      </ul>
    </section>}

    <section className="panel">
      <h2>Yêu cầu và bằng chứng</h2>
      <p className="muted small" style={{ marginTop: 2 }}>Test đạt chứng minh các assertion đã chạy. Phần hình thức được đối chiếu riêng với Figma; các phần chưa có bằng chứng vẫn cần xem lại.</p>
      <div className="table-scroll"><table className="compact" style={{ marginTop: 10 }}><thead><tr><th>Mã</th><th>Yêu cầu</th><th>Kết luận yêu cầu</th><th>Kiểm tra tự động</th>{run.contract.design && <th>Hình thức</th>}</tr></thead><tbody>
        {report.requirements.map((q) => <tr key={q.id}><td><code>{q.id}</code></td><td>{q.text}{q.kind === 'forbidden' && <Badge tone="warn" plain>Không được xảy ra</Badge>}</td>
          <td><Badge tone={q.manual && q.tests.length ? 'info' : ROW_TONE[q.status]}>{q.manual && q.tests.length ? 'Đã kiểm tra một phần' : ROW_LABEL[q.status]}</Badge>{q.manual && <p className="small muted">{q.tests.length ? 'Cần đối chiếu phần còn lại theo hợp đồng.' : 'Chưa có bằng chứng tự động cho yêu cầu này.'}</p>}</td>
          <td>{q.tests.length ? <><Badge tone="good">{q.tests.length} test đạt</Badge><details><summary>Xem test đã chạy</summary><ul className="plain-list">{q.tests.map((t) => <li key={t} className="small">{t}</li>)}</ul></details></> : <span className="faint">Chưa có test đạt</span>}</td>
          {run.contract.design && <td><Badge tone={q.visual?.status === 'passed' ? 'good' : q.visual?.status === 'different' ? 'bad' : 'warn'}>{{ passed: 'Trong ngưỡng so ảnh', different: 'Có vùng khác', needs_review: 'Đã đo · cần đối chiếu', incomplete: 'Chưa hoàn tất', unverified: 'Chưa có bằng chứng' }[q.visual?.status ?? 'unverified']}</Badge>{!!q.visual?.checked && <p className="small muted">{q.visual.checked} màn hình được đối chiếu</p>}</td>}</tr>)}
      </tbody></table></div>
      {report.assumptions.length > 0 && <><h3>Giả định đã nêu trong hợp đồng</h3><ul className="plain-list">{report.assumptions.map((a) => <li key={a}>{a}</li>)}</ul></>}
    </section>

    <VisualReview detail={detail} onChanged={() => void load()}/>

    <section className="panel">
      <div className="card-head"><h2>Thay đổi so với bản gốc</h2>{report.changes.available && <span className="muted small">{report.changes.files.length} file · <span className="out">+{report.changes.added}</span> <span className="in">−{report.changes.removed}</span></span>}</div>
      {!report.changes.available ? <p className="muted small">Không lấy được thống kê; xem diff ở tab Mã nguồn.</p> : !report.changes.files.length ? <p className="muted small">Không có thay đổi nào.</p> : <>
        <ul className="filelist">{report.changes.files.map((f) => <li key={f.path}><span className={`kind kind-${f.status}`}>{KIND[f.status]}</span><code>{f.path}</code>{report.changes.testFiles.includes(f.path) && <Badge tone="info" plain>test</Badge>}<span className="out num">+{f.added}</span><span className="in num">−{f.removed}</span></li>)}</ul>
        <button className="text-button" onClick={() => setShowDiff((v) => !v)}>{showDiff ? 'Ẩn diff đầy đủ' : 'Xem diff đầy đủ'}</button>
        {showDiff && <DiffView text={report.changes.patch}/>}</>}
    </section>

    <section className="panel">
      <h2>Kết quả chạy test</h2>
      {!report.checks.length ? <p className="muted small">Chưa có check nào trên checkpoint này.</p> : <table className="compact" style={{ marginTop: 10 }}><thead><tr><th>Lệnh</th><th>Kết quả</th><th>Pass</th><th>Fail</th><th>Bỏ qua</th><th>Thời gian</th></tr></thead><tbody>
        {report.checks.map((c) => <tr key={c.id}><td className="mono" style={{ maxWidth: 360, overflowWrap: 'anywhere' }}>{c.command}</td>
          <td><Badge tone={c.status === 'passed' ? 'good' : c.status === 'failed' ? 'bad' : 'warn'}>{c.status === 'passed' ? 'Pass' : c.status === 'failed' ? 'Fail' : c.status === 'flaky' ? 'Flaky' : 'Chưa hoàn tất'}</Badge>{c.quarantined && <Badge tone="neutral" plain>quarantine</Badge>}</td>
          {c.passed === null
            // No readable test report (typecheck, lint, or a check that ran before counting existed): unknown, never "0 passed".
            ? <td colSpan={3} className="muted small" title="Check này không có báo cáo test nên không có số liệu pass/fail">Không có báo cáo test, chỉ có kết quả mã thoát</td>
            : <><td className="out num">{c.passed}</td><td className={`num ${c.failed ? 'in' : ''}`}>{c.failed ?? 0}</td>
              <td className="num">{c.skipped ?? 0}{c.skippedNames.length > 0 && <details><summary className="small">xem</summary><ul className="plain-list">{c.skippedNames.map((n) => <li key={n} className="small">{n}</li>)}</ul></details>}</td></>}
          <td className="num muted">{duration(c.durationMs)}{c.runs > 1 ? ` · ${c.runs} lần` : ''}</td></tr>)}
      </tbody></table>}
    </section>

    <section className="panel">
      <h2>Verifier độc lập</h2>
      {!report.verifier.expected ? <p className="muted small">Chế độ {report.mode} không có Verifier độc lập; kết quả được tự review bởi chính agent đã làm.</p>
        : !report.verifier.verdict ? <p className="muted small">Bản code này chưa có kết luận Verifier</p> : <>
          <div className="row-actions" style={{ marginTop: 6 }}><Badge tone={DECISION[report.verifier.verdict.decision]?.tone ?? 'neutral'}>{DECISION[report.verifier.verdict.decision]?.label ?? report.verifier.verdict.decision}</Badge><span className="muted small">{report.verifier.verdict.findingCount} finding</span></div>
          {report.verifier.verdict.summary && <blockquote className="quote">{report.verifier.verdict.summary}</blockquote>}</>}
      {report.verifier.findings.length > 0 && <ul className="plain-list">{report.verifier.findings.map((f, i) => <li key={i}><Badge tone={f.severity === 'blocker' ? 'bad' : f.severity === 'major' ? 'warn' : 'neutral'}>{f.severity}</Badge> {f.title} <span className="faint small">{f.location} · {f.status}</span></li>)}</ul>}
    </section>

    <div className="section-split">
      <section className="panel"><h2>Công sức</h2>
        <dl className="facts"><dt>Chi phí</dt><dd>~{money(report.effort.costUsd)}{report.effort.estimated ? ' (ước tính)' : ''}</dd><dt>Token</dt><dd>{count(report.effort.tokens)}</dd><dt>Lượt agent</dt><dd>{report.effort.attempts}, {report.effort.repairs} vòng sửa</dd><dt>Thời gian AI</dt><dd>{duration(report.effort.aiMs)}</dd><dt>Công của bạn</dt><dd>{duration(report.effort.humanMs)}</dd></dl></section>
      <section className="panel"><h2>Nhận kết quả</h2>
        <p className="small muted" style={{ marginTop: 2 }}>{report.delivery.kind === 'files'
          ? <>Ghi file trực tiếp vào <code>{report.delivery.target}</code>. {report.delivery.delivered ? 'Đã giao thành công.' : 'Chưa xác nhận giao thành công; hệ thống kiểm tra xung đột trước khi ghi.'}</>
          : <>Branch <code>{report.delivery.target}</code> trong <code>{report.delivery.repository}</code> {report.delivery.delivered ? 'đã được giao.' : 'chưa được xác nhận giao thành công. Hệ thống không tự merge hay push.'}</>}</p>
        <ul className="cmdlist">{report.delivery.commands.map((c) => <li key={c}><code>{c}</code><Copy text={c}/></li>)}</ul></section>
    </div>

    <div className="decision-bar">
      {done ? <span className="muted"><span className="kicker">Đã ký nghiệm thu</span>{run.acceptedAt ? `Lúc ${dateTime(run.acceptedAt)}. ` : ''}Báo cáo bạn đã xem được lưu cùng việc này.</span> : <>
        <div className="decision-text"><span className="kicker">Nghiệm thu</span>
          {needAck ? <label className="ack"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)}/> Tôi đã đọc {warns.length} cảnh báo ở trên và vẫn muốn nghiệm thu</label>
            : <span className="muted small">{report.readiness === 'not_ready' ? 'Chưa ký được: còn điều kiện chưa đạt.' : report.delivery.kind === 'files' ? 'Ký nhận và ghi file trực tiếp vào project sau khi kiểm tra xung đột.' : 'Ký nhận kết quả. Hệ thống tạo branch, không tự merge hay push.'}</span>}</div>
        <div className="row-actions" style={{ margin: 0 }}>
          <button className="button primary" disabled={busy || delivering || report.readiness === 'not_ready' || (needAck && !ack)} onClick={() => void onAccept(ack)}>{delivering ? 'Đang giao kết quả…' : retry ? 'Thử giao lại' : 'Nghiệm thu'}</button>
          {run.status !== 'completed' && <button className="button" disabled={busy || delivering} onClick={onReject}>Từ chối</button>}
        </div></>}
    </div>
  </div>;
}
