import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CostRow, LiveRun, MonitorData, Period, RequestRow, Totals, WaitingItem } from '../core/monitor';
import type { WasteItem } from '../core/waste';
import type { Health, Mode } from '../shared/types';
import { api } from './api';
import { LogConsole } from './Monitor';
import { MetricChart, RecentRequests, ROLE_COLOR, STATUS_TONE, Topology, num, type ChartMetric } from './MonitorCharts';
import { Badge, Empty, Icon, Ledger, Modal, ago, count, dateTime, duration, money } from './ui';

export function Delta({ now, before, period, invert = false, format = num }: { now: number; before: number; period: Period; invert?: boolean; format?: (n: number) => string }) {
  if (!before && !now) return <small className="delta">không đổi so với {PREVIOUS_LABEL[period]}</small>;
  if (!before) return <small className="delta">mới so với {PREVIOUS_LABEL[period]}</small>;
  // Nothing ran yet in this period: neutral, with the earlier figure, rather than a green "↓ 100%".
  if (!now) return <small className="delta">chưa có hoạt động ({PREVIOUS_LABEL[period]}: {format(before)})</small>;
  const pct = Math.round(((now - before) / before) * 100);
  const tone = pct === 0 ? '' : (pct > 0) !== invert ? 'up' : 'down';
  return <small className={`delta ${tone}`}>{pct > 0 ? '↑' : pct < 0 ? '↓' : '→'} {Math.abs(pct)}% so với {PREVIOUS_LABEL[period]}</small>;
}

export function Kpis({ data }: { data: MonitorData }) {
  const t = data.totals, p: Totals = data.previous;
  const wastePct = t.costUsd > 0 ? Math.round((data.waste.costUsd / t.costUsd) * 100) : 0;
  const cards: { label: string; value: string; dot: string; note?: React.ReactNode; tone?: string }[] = [
    { label: 'Lượt gọi agent', value: num(t.requests), dot: 'var(--text-3)', note: <><Delta now={t.requests} before={p.requests} period={data.period}/>{t.failed > 0 && <small className="bad-text">{t.failed} lỗi hoặc bị ngắt</small>}</> },
    { label: 'Token', value: count(t.inputTokens + t.outputTokens), dot: 'var(--c-in)', note: <><small>vào {count(t.inputTokens)} · ra {count(t.outputTokens)}</small><Delta now={t.inputTokens + t.outputTokens} before={p.inputTokens + p.outputTokens} period={data.period} format={count}/></> },
    { label: 'Tỉ lệ cache', value: t.inputTokens ? `${Math.round(data.cacheRate * 100)}%` : '—', dot: 'var(--c-cache)', note: <small>{t.inputTokens ? 'token vào đọc lại từ cache (rẻ hơn ~10 lần)' : 'Chưa có token nào trong kỳ'}</small> },
    { label: 'Chi phí ước tính', value: `~${money(t.costUsd)}`, dot: 'var(--c-cost)', tone: 'cost', note: <><Delta now={t.costUsd} before={p.costUsd} period={data.period} format={(n) => `~${money(n)}`}/><small>{t.estimated ? 'Ước tính, không phải hóa đơn' : 'Theo báo cáo của provider'}</small></> },
    { label: 'Chi phí / task nghiệm thu', value: data.costPerAccepted === null ? '—' : `~${money(data.costPerAccepted)}`, dot: 'var(--c-out)', note: <small>{data.acceptedInPeriod ? `${data.acceptedInPeriod} task nghiệm thu trong kỳ (tính cả đời task)` : 'Chưa có task nghiệm thu trong kỳ'}</small> },
    { label: 'Lãng phí ước tính', value: `~${money(data.waste.costUsd)}`, dot: 'var(--warn)', tone: data.waste.costUsd > 0 ? 'warn' : '', note: <small>{data.waste.costUsd > 0 ? `${wastePct}% chi phí kỳ này, xem chi tiết bên dưới` : 'Không thấy lãng phí trong kỳ'}</small> },
  ];
  return <Ledger className="ledger-3" items={cards.map((c) => ({ label: c.label, value: c.value, sub: c.note, tone: c.tone === 'warn' ? 'warn' as const : undefined }))}/>;
}

export function LivePanel({ live, now }: { live: LiveRun[]; now: number }) {
  return <section className="panel-card">
    <div className="card-head"><h3>Đang chạy</h3><span className="muted small">{live.length ? `${live.length} task` : ''}</span></div>
    {!live.length ? <p className="muted small">Không có task nào đang chạy.</p> : <ul className="live-list">{live.map((r) => <li key={r.id}>
      <div className="live-top"><span className="dot dot-live"/><a className="cell-title" href={`#/run/${r.id}`} title={r.title}>{r.title}</a></div>
      <div className="live-meta"><span className="muted small">{STAGE_LABEL[r.stage] ?? r.stage} · {MODE_LABEL[r.mode as Mode] ?? r.mode}</span>
        {r.role ? <><Badge tone="info" live>{ROLE_LABEL[r.role] ?? r.role}</Badge>{r.attemptStartedAt && <span className="mono small">{duration(now - Date.parse(r.attemptStartedAt))}</span>}</> : <span className="muted small">đang chuẩn bị hoặc chạy check</span>}</div>
      <div className="budget-line" title={`Đã dùng ~${money(r.spentUsd)} / ${money(r.capUsd)}`}><span className="bar"><span style={{ width: `${Math.min(100, r.budgetPct * 100)}%` }} className={r.budgetPct > 0.85 ? 'hot' : ''}/></span><small>{Math.round(r.budgetPct * 100)}% ngân sách</small></div>
      {r.lastLog && <code className="live-log" title={r.lastLog}>{r.lastLog}</code>}
    </li>)}</ul>}
  </section>;
}

export function WaitingPanel({ items, now }: { items: WaitingItem[]; now: number }) {
  return <section className="panel-card">
    <div className="card-head"><h3>Chờ bạn</h3>{items.length > 0 && <span className="muted small">{items.length} việc</span>}</div>
    {!items.length ? <p className="muted small">Không có việc nào chờ bạn.</p> : <ul className="wait-list">{items.map((w) => {
      const meta = WAIT[w.kind];
      const href = w.runId ? `#/run/${w.runId}` : '#/projects';
      return <li key={`${w.kind}-${w.runId ?? w.projectId}`}>
        <div className="wait-main"><Badge tone={meta.tone}>{meta.label}</Badge><a className="cell-title" href={href} title={w.title}>{w.title}</a></div>
        {w.detail && <p className="wait-detail" title={w.detail}>{w.detail}</p>}
        <div className="wait-foot"><span className="faint small">{ago(w.updatedAt, now)}</span><a className="button small" href={href}>{meta.action}</a></div>
      </li>;
    })}</ul>}
  </section>;
}

export function SpendPanel({ data }: { data: MonitorData }) {
  const [by, setBy] = useState<'task' | 'role' | 'project'>('task');
  const [all, setAll] = useState(false);
  const rows: CostRow[] = by === 'task' ? data.byTask : by === 'role' ? data.byRole : data.byProject;
  const shown = all ? rows : rows.slice(0, 10);
  const max = Math.max(...rows.map((r) => r.costUsd), 0.000001);
  return <section className="panel-card">
    <div className="card-head"><h3>Tiền đi đâu</h3>
      <div className="segmented" role="group" aria-label="Nhóm theo">{([['task', 'Theo task'], ['role', 'Theo vai'], ['project', 'Theo project']] as const).map(([k, l]) => <button key={k} className={by === k ? 'active' : ''} aria-pressed={by === k} onClick={() => setBy(k)}>{l}</button>)}</div></div>
    {!rows.length ? <p className="muted small">Chưa có chi phí trong kỳ này.</p> : <div className="spend-table"><table><thead><tr><th>{by === 'task' ? 'Task' : by === 'role' ? 'Vai' : 'Project'}</th><th className="num">Lượt</th><th className="num">Token</th><th className="num">Chi phí</th><th className="share-col">Tỉ lệ</th></tr></thead><tbody>
      {shown.map((r) => <tr key={r.key}>
        <td className="spend-label">{r.runId ? <a href={`#/run/${r.runId}`} title={r.label}>{r.label}</a> : <span title={r.label}>{by === 'role' && <i className="sw" style={{ background: ROLE_COLOR[r.key] ?? 'var(--text-3)' }}/>}{r.label}</span>}
          {r.status && <small className={`status-note tone-${STATUS_TONE_RUN[r.status] ?? 'neutral'}`}>{STATUS_LABEL[r.status] ?? r.status}{r.repairs ? ` · ${r.repairs} vòng sửa` : ''}</small>}</td>
        <td className="num">{num(r.requests)}</td><td className="num">{count(r.inputTokens + r.outputTokens)}</td><td className="num strong">~{money(r.costUsd)}</td>
        <td className="share-col"><span className="share"><span style={{ width: `${(r.costUsd / max) * 100}%`, background: by === 'role' ? (ROLE_COLOR[r.key] ?? 'var(--accent)') : 'var(--accent)' }}/></span></td>
      </tr>)}
    </tbody></table>{rows.length > 10 && <button className="text-button" onClick={() => setAll((v) => !v)}>{all ? 'Thu gọn' : `Xem cả ${rows.length}`}</button>}</div>}
  </section>;
}

const WASTE_SHOWN = 5;
export function WastePanel({ data, now }: { data: MonitorData; now: number }) {
  const { items, costUsd } = data.waste;
  const [all, setAll] = useState(false);
  return <section className="panel-card">
    <div className="card-head"><h3>Lãng phí</h3>{items.length > 0 && <span className="muted small">~{money(costUsd)} trong kỳ</span>}</div>
    {!items.length ? <p className="muted small">Không thấy lượt nào chạy lại vô ích, lỗi hay task kẹt trong kỳ này.</p> : <ul className="waste-list">{(all ? items : items.slice(0, WASTE_SHOWN)).map((w, i) => <li key={`${w.kind}-${w.runId}-${i}`}>
      <div className="wait-main"><Badge tone={WASTE_LABEL[w.kind][1]}>{WASTE_LABEL[w.kind][0]}</Badge><a className="cell-title" href={`#/run/${w.runId}`} title={w.runTitle}>{w.runTitle}</a>{w.costUsd > 0 && <strong className="waste-cost">~{money(w.costUsd)}</strong>}</div>
      <p className="wait-detail">{w.detail}</p>
      <span className="faint small">{ago(w.at, now)}</span>
    </li>)}</ul>}
    {items.length > WASTE_SHOWN && <button className="text-button" onClick={() => setAll((v) => !v)}>{all ? 'Thu gọn' : `Xem cả ${items.length}`}</button>}
    {items.some((i) => i.kind === 'repeat-review') && <p className="muted small waste-tip">Verifier lặp thường do bấm Chạy tiếp khi không có gì thay đổi. Hãy sửa hợp đồng hoặc check trước, rồi mới chạy lại.</p>}
  </section>;
}

export function LiveTab({ data, now, onOpen }: { data: MonitorData; now: number; onOpen: (r: RequestRow) => void }) {
  const [consoleOpen, setConsoleOpen] = useState(() => { try { return localStorage.getItem('monitor.console') !== 'closed'; } catch { return true; } });
  const rememberConsole = (open: boolean) => { setConsoleOpen(open); try { localStorage.setItem('monitor.console', open ? 'open' : 'closed'); } catch { /* private mode */ } };
  return <>
    {data.alerts.map((a) => <div key={a.text} className={`banner ${a.level === 'error' ? 'error' : 'warn'}`} role="alert"><Icon name="alert" size={16}/><span>{a.text}</span></div>)}
    <div className="overview-grid live-grid"><Topology data={data}/><RecentRequests rows={data.recent} now={now} onOpen={onOpen}/></div>
    <div className="section-split overview-split"><LivePanel live={data.live} now={now}/><WaitingPanel items={data.waiting} now={now}/></div>
    <details className="topology-details console-details" open={consoleOpen} onToggle={(e) => rememberConsole((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>Console trực tiếp{data.errorsLastHour ? <span className="pill alert">{data.errorsLastHour} lỗi / 1 giờ</span> : null}</summary>
      {consoleOpen && <LogConsole height={380}/>}
    </details>
  </>;
}

export function CostTab({ data, now, onOpen }: { data: MonitorData; now: number; onOpen: (r: RequestRow) => void }) {
  const [metric, setMetric] = useState<ChartMetric>('cost');
  return <>
    <Kpis data={data}/>
    <div className="chart-card">
      <div className="card-head"><h3>{metric === 'tokens' ? 'Token' : metric === 'cost' ? 'Chi phí theo vai' : 'Lượt gọi'} theo {data.unit === 'hour' ? 'giờ' : 'ngày'}</h3>
        <div className="segmented" role="group" aria-label="Chỉ số">{([['cost', 'Chi phí'], ['tokens', 'Token'], ['requests', 'Lượt gọi']] as const).map(([k, l]) => <button key={k} className={metric === k ? 'active' : ''} aria-pressed={metric === k} onClick={() => setMetric(k)}>{l}</button>)}</div></div>
      {metric === 'tokens' && <div className="legend chart-legend"><span><i className="sw sw-in"/>Vào (không cache)</span><span><i className="sw sw-cache"/>Cache</span><span><i className="sw sw-out"/>Ra</span></div>}
      <MetricChart series={data.series} unit={data.unit} metric={metric}/>
    </div>
    <div className="section-split overview-split cost-split"><SpendPanel data={data}/><WastePanel data={data} now={now}/></div>
    <details className="topology-details"><summary>Chi tiết lượt gọi và model</summary><Requests data={data} now={now} onOpen={onOpen}/></details>
    <details className="topology-details"><summary>Hiệu quả theo chế độ và ngữ cảnh</summary><Insights/></details>
  </>;
}

export function Requests({ data, now, onOpen }: { data: MonitorData; now: number; onOpen: (r: RequestRow) => void }) {
  const [task, setTask] = useState(''), [role, setRole] = useState(''), [status, setStatus] = useState(''), [model, setModel] = useState(''), [q, setQ] = useState('');
  const options = useMemo(() => ({
    tasks: [...new Map(data.recent.map((r) => [r.runId, r.runTitle])).entries()],
    roles: [...new Set(data.recent.map((r) => r.role))], statuses: [...new Set(data.recent.map((r) => r.status))], models: [...new Set(data.recent.map((r) => `${r.provider}/${r.model}`))],
  }), [data.recent]);
  const rows = data.recent.filter((r) => (!task || r.runId === task) && (!role || r.role === role) && (!status || r.status === status) && (!model || `${r.provider}/${r.model}` === model)
    && (!q || `${r.runTitle} ${r.role} ${r.model} ${r.error ?? ''}`.toLowerCase().includes(q.toLowerCase())));
  const sum = rows.reduce((s, r) => ({ i: s.i + r.inputTokens, o: s.o + r.outputTokens, c: s.c + r.costUsd }), { i: 0, o: 0, c: 0 });
  return <>
    <h2 className="section-title" style={{ marginTop: 0 }}>Theo model</h2>
    {!data.byModel.length ? <Empty title="Chưa có dữ liệu">Chưa có lượt gọi nào trong khoảng thời gian này.</Empty> :
      <div className="table-card"><table><thead><tr><th>Provider / model</th><th className="num">Lượt</th><th className="num">Lỗi</th><th className="num">Vào</th><th className="num">Cache</th><th className="num">Ra</th><th className="num">Chi phí</th></tr></thead><tbody>
        {data.byModel.map((m) => <tr key={`${m.provider}/${m.model}`}><td className="mono">{m.provider}/{m.model}</td><td className="num">{num(m.requests)}</td><td className="num">{m.failed || '—'}</td><td className="num">{count(m.inputTokens)}</td><td className="num">{count(m.cachedTokens)}</td><td className="num">{count(m.outputTokens)}</td><td className="num">{money(m.costUsd)}</td></tr>)}
      </tbody></table></div>}
    <h2 className="section-title">Lượt gọi gần đây <span className="muted small">(80 lượt mới nhất)</span></h2>
    <div className="filter-bar">
      <select aria-label="Lọc theo task" value={task} onChange={(e) => setTask(e.target.value)}><option value="">Mọi task</option>{options.tasks.map(([id, t]) => <option key={id} value={id}>{t.slice(0, 60)}</option>)}</select>
      <select aria-label="Lọc theo vai" value={role} onChange={(e) => setRole(e.target.value)}><option value="">Mọi vai</option>{options.roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r] ?? r}</option>)}</select>
      <select aria-label="Lọc theo trạng thái" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Mọi trạng thái</option>{options.statuses.map((s) => <option key={s} value={s}>{s}</option>)}</select>
      <select aria-label="Lọc theo model" value={model} onChange={(e) => setModel(e.target.value)}><option value="">Mọi model</option>{options.models.map((m) => <option key={m} value={m}>{m}</option>)}</select>
      <input aria-label="Tìm" placeholder="Tìm theo task, lỗi…" value={q} onChange={(e) => setQ(e.target.value)}/>
    </div>
    {!rows.length ? <Empty title="Không có lượt gọi">Không có lượt nào khớp bộ lọc.</Empty> :
      <div className="table-card"><table><thead><tr><th>Bắt đầu</th><th>Task</th><th>Vai</th><th>Model</th><th>Trạng thái</th><th className="num">Thời lượng</th><th className="num">Vào</th><th className="num">Ra</th><th className="num">Chi phí</th></tr>
        <tr className="sum-row"><td colSpan={6}>{rows.length} lượt</td><td className="num">{count(sum.i)}</td><td className="num">{count(sum.o)}</td><td className="num">~{money(sum.c)}</td></tr></thead><tbody>
        {rows.map((a) => <tr key={a.id} className="clickable" onClick={() => onOpen(a)}>
          <td className="muted">{dateTime(a.startedAt)}</td><td className="cell-title" title={a.runTitle}>{a.runTitle}</td><td>{ROLE_LABEL[a.role] ?? a.role}/{a.slot}</td><td className="mono">{a.model}</td>
          <td><Badge tone={STATUS_TONE[a.status] ?? 'neutral'} live={a.status === 'running'}>{a.status}</Badge></td>
          <td className="num">{duration((a.endedAt ? Date.parse(a.endedAt) : now) - Date.parse(a.startedAt))}</td>
          <td className="num">{count(a.inputTokens)}</td><td className="num">{count(a.outputTokens)}</td><td className="num">{money(a.costUsd)}</td></tr>)}
      </tbody></table></div>}
  </>;
}

export function Insights() {
  const [rows, setRows] = useState<ModeSummary[] | null>(null);
  const [arms, setArms] = useState<{ on: ContextArm; off: ContextArm } | null>(null);
  useEffect(() => {
    void api<ModeSummary[]>('/api/metrics').then(setRows).catch(() => setRows([]));
    void api<{ on: ContextArm; off: ContextArm }>('/api/metrics/context').then(setArms).catch(() => setArms(null));
  }, []);
  if (rows === null) return <p className="muted">Đang tải…</p>;
  if (!rows.length) return <Empty title="Chưa có dữ liệu">Dữ liệu xuất hiện sau khi có task.</Empty>;
  return <>
    <h2 className="section-title" style={{ marginTop: 0 }}>Theo chế độ</h2>
    <p className="muted small" style={{ marginTop: 0 }}>Nhóm theo chế độ lúc bắt đầu. Task chuyển Single → Team vẫn tính vào Single; task chưa xong vẫn tính đủ chi phí.</p>
    <div className="table-card"><table><thead><tr><th>Chế độ</th><th className="num">Task</th><th className="num">Nghiệm thu</th><th className="num">Chưa xong</th><th className="num">Đã chuyển</th><th className="num">Chi phí / task</th><th className="num">Lãng phí / task</th><th className="num">Công của bạn / task</th></tr></thead><tbody>
      {rows.map((r) => <tr key={r.mode}><td className="cell-title">{MODE_LABEL[r.mode]}</td><td className="num">{r.runs}</td><td className="num">{r.accepted} <span className="faint">({Math.round(r.acceptedRate * 100)}%)</span></td><td className="num">{r.unfinished}</td><td className="num">{r.escalated}</td><td className="num">{money(r.costPerRun)}{r.costEstimated && <small className="cell-note">có ước tính</small>}</td><td className="num">{r.wastePerRun !== undefined ? money(r.wastePerRun) : '—'}</td><td className="num">{r.humanMinutesPerRun.toFixed(1)} phút</td></tr>)}
    </tbody></table></div>
    <h2 className="section-title">Có / không có ngữ cảnh project</h2>
    {!arms || arms.on.runs + arms.off.runs === 0 ? <p className="muted small">Chưa có task chạy thật nào để so sánh. Bật ngữ cảnh ở nút "Ngữ cảnh" trên thẻ project.</p> :
      <div className="table-card"><table><thead><tr><th>Nhóm</th><th className="num">Task</th><th className="num">Nghiệm thu</th><th className="num">Vòng sửa / task</th><th className="num">Chi phí / task</th></tr></thead><tbody>
        {([['Có ngữ cảnh', arms.on], ['Không ngữ cảnh', arms.off]] as const).map(([label, a]) => <tr key={label}><td className="cell-title">{label}</td><td className="num">{a.runs}</td><td className="num">{a.accepted} <span className="faint">({Math.round(a.acceptedRate * 100)}%)</span></td><td className="num">{a.repairsPerRun.toFixed(1)}</td><td className="num">{money(a.costPerRun)}{a.costEstimated && <small className="cell-note">có ước tính</small>}</td></tr>)}
      </tbody></table></div>}
    <p className="notice" style={{ marginTop: 14 }}><Icon name="info" size={16}/><span>Số liệu từ sử dụng thực tế, chưa phải thử nghiệm có đối chứng. Để so sánh Native Full, Harness-Single và Harness-Team hãy dùng bộ đo M0 (<code>npm run eval</code>) với manifest đã đăng ký trước.</span></p>
  </>;
}

export function SystemPane() {
  const [health, setHealth] = useState<Health | null>(null);
  const [storage, setStorage] = useState<StorageReport | null>(null);
  const [previews, setPreviews] = useState<PreviewState[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState('');
  const loadStorage = useCallback(async (refresh = false) => { try { setStorage(await api<StorageReport>(`/api/system/storage${refresh ? '?refresh=1' : ''}`)); } catch (e) { setMessage((e as Error).message); } }, []);
  const loadPreviews = useCallback(async () => { try { setPreviews(await api<PreviewState[]>('/api/system/previews')); } catch { setPreviews([]); } }, []);
  useEffect(() => { void api<Health>('/api/health').then(setHealth).catch(() => setHealth(null)); void loadStorage(); void loadPreviews(); }, [loadStorage, loadPreviews]);
  // While sizes are being measured, ask again every few seconds.
  useEffect(() => { if (!storage?.computing) return; const t = setTimeout(() => void loadStorage(), 3000); return () => clearTimeout(t); }, [storage, loadStorage]);

  async function cleanup() {
    setConfirm(false); setMessage('');
    try {
      const r = await api<{ removed: string[]; refused: { runId: string; reason: string }[] }>('/api/system/cleanup', 'POST', { runIds: [...selected] });
      setMessage(`Đã dọn ${r.removed.length} bản sao${r.refused.length ? `; giữ lại ${r.refused.length}: ${r.refused.map((x) => x.reason).join(' ')}` : ''}.`);
      setSelected(new Set()); await loadStorage(true);
    } catch (e) { setMessage((e as Error).message); }
  }
  const disk = health?.disk ?? storage?.disk ?? null;
  const freeing = storage?.workspaces.filter((w) => selected.has(w.runId)).reduce((s, w) => s + w.sizeBytes, 0) ?? 0;
  const items: { title: string; ok: boolean; note: string }[] = health ? [
    { title: 'Codex local', ok: health.localCodex, note: `CLI trên máy này, đã đăng nhập.${health.codexVersion ? ` ${health.codexVersion}` : ''}` },
    { title: 'Docker', ok: health.docker, note: health.dockerMessage },
    { title: 'Codex trong Docker', ok: health.codex, note: 'Cần attestation của project.' },
    { title: 'Claude Code', ok: health.claude, note: 'Cần attestation và khóa API.' },
    { title: 'Chạy thật', ok: health.liveReady, note: 'Mô phỏng luôn sẵn sàng nhưng không tạo bằng chứng.' },
  ] : [];
  return <>
    {!health ? <p className="muted">Đang kiểm tra…</p> : <div className="health-grid">
      {disk && <div className={`card disk-card level-${disk.level}`}><div className="card-head"><h3>Ổ đĩa {disk.path}</h3><Badge tone={disk.level === 'ok' ? 'good' : disk.level === 'warn' ? 'warn' : 'bad'}>{disk.level === 'ok' ? 'Đủ chỗ' : disk.level === 'warn' ? 'Sắp đầy' : 'Gần hết chỗ'}</Badge></div>
        <div className="disk-bar"><span style={{ width: `${Math.min(100, (1 - disk.freeBytes / Math.max(1, disk.totalBytes)) * 100)}%` }}/></div>
        <p className="muted small" style={{ marginBottom: 0 }}>Còn trống {bytes(disk.freeBytes)} / {bytes(disk.totalBytes)}. Dưới 5 GB sẽ cảnh báo; khi hết chỗ, npm, test và Codex lỗi.</p></div>}
      <div className="card"><div className="card-head"><h3>Node.js</h3><span className="mono small">{health.node}</span></div></div>
      {items.map((i) => <div className="card" key={i.title}><div className="card-head"><h3>{i.title}</h3><Badge tone={i.ok ? 'good' : 'warn'}>{i.ok ? 'Sẵn sàng' : 'Chưa sẵn sàng'}</Badge></div><p className="muted small" style={{ marginBottom: 0 }}>{i.note}</p></div>)}
    </div>}

    <h2 className="section-title">Bản sao làm việc <span className="muted small">{storage ? `${storage.workspaces.length} task · ${bytes(storage.totalBytes)}` : ''}</span></h2>
    <p className="muted small" style={{ marginTop: 0 }}>Mỗi task có một bản sao code (cả <code>node_modules</code>) trong <code>.data/workspaces</code>. Dọn bản sao không đụng project gốc, nhưng task đó sẽ không chạy lại check hay Chạy thử được nữa. Chỉ dọn được task đã nghiệm thu, task bị chặn hoặc thất bại hơn 7 ngày, hoặc bản sao không còn task.</p>
    <div className="row-actions">
      <button className="button small" onClick={() => void loadStorage(true)} disabled={storage?.computing}>{storage?.computing ? 'Đang đo dung lượng…' : 'Đo lại'}</button>
      <button className="button small" onClick={() => setSelected(new Set(storage?.workspaces.filter((w) => w.removable).map((w) => w.runId)))} disabled={!storage?.workspaces.some((w) => w.removable)}>Chọn mọi bản dọn được</button>
      <button className="button primary small" disabled={!selected.size} onClick={() => setConfirm(true)}>Dọn {selected.size} bản sao{selected.size ? ` (giải phóng ~${bytes(freeing)})` : ''}</button>
      {storage?.computedAt && <span className="faint small">đo lúc {dateTime(storage.computedAt)}</span>}
    </div>
    {message && <p className="notice-line">{message}</p>}
    {!storage ? <p className="muted">Đang tải…</p> : !storage.workspaces.length ? <p className="muted small">{storage.computing ? 'Đang đo…' : 'Chưa có bản sao nào.'}</p> :
      <div className="table-card"><table><thead><tr><th/><th>Task</th><th>Trạng thái</th><th className="num">Dung lượng</th><th className="num">File</th><th>Dọn được?</th></tr></thead><tbody>
        {storage.workspaces.map((w) => <tr key={w.runId}>
          <td><input type="checkbox" aria-label={`Chọn ${w.title ?? w.runId}`} disabled={!w.removable} checked={selected.has(w.runId)} onChange={(e) => setSelected((cur) => { const n = new Set(cur); if (e.target.checked) n.add(w.runId); else n.delete(w.runId); return n; })}/></td>
          <td className="cell-title">{w.title ? <a href={`#/run/${w.runId}`} title={w.title}>{w.title}</a> : <span className="faint">(không còn task) {w.runId}</span>}</td>
          <td>{w.status ? <Badge tone={STATUS_TONE_RUN[w.status] ?? 'neutral'}>{STATUS_LABEL[w.status] ?? w.status}</Badge> : '—'}</td>
          <td className="num strong">{bytes(w.sizeBytes)}{w.truncated && '+'}</td><td className="num">{num(w.files)}</td>
          <td className="small">{w.removable ? <span className="good-text">Có</span> : <span className="muted">Không</span>} <span className="faint">· {w.reason}</span></td>
        </tr>)}
      </tbody></table></div>}

    <h2 className="section-title">Phiên Chạy thử đang mở</h2>
    {!previews.length ? <p className="muted small">Không có.</p> : <div className="table-card"><table><thead><tr><th>Task</th><th>Địa chỉ</th><th>Lệnh</th><th>Tự tắt lúc</th><th/></tr></thead><tbody>
      {previews.map((p) => <tr key={p.runId}><td><a href={`#/run/${p.runId}`}>{p.runId}</a></td><td><a href={p.url} target="_blank" rel="noopener noreferrer" className="mono">{p.url}</a></td><td className="mono small">{p.command.join(' ')}</td><td>{dateTime(p.stopsAt)}</td>
        <td><button className="button ghost small" onClick={() => void api(`/api/runs/${p.runId}/preview/stop`, 'POST', {}).then(loadPreviews)}>Dừng</button></td></tr>)}
    </tbody></table></div>}

    {health && <><h2 className="section-title">Giới hạn hiện tại</h2><ul className="plain-list">{health.limitations.map((l) => <li key={l}>{l}</li>)}</ul></>}
    {confirm && <Modal title={`Dọn ${selected.size} bản sao làm việc?`} subtitle="Thao tác này không hoàn tác được." onClose={() => setConfirm(false)}><div>
      <p>Sẽ xóa thư mục bản sao (kể cả <code>node_modules</code>) của {selected.size} task trong <code>.data/workspaces</code>, giải phóng khoảng {bytes(freeing)}. Project gốc của bạn không bị đụng tới.</p>
      <p className="muted small">Sau khi dọn, các task này không chạy lại check, Chạy thử hay xem diff đầy đủ được nữa. Lịch sử, báo cáo và chi phí vẫn giữ.</p>
      <div className="modal-footer"><button className="button secondary" onClick={() => setConfirm(false)}>Hủy</button><button className="button primary" onClick={() => void cleanup()}>Dọn</button></div>
    </div></Modal>}
  </>;
}

export const MODE_LABEL: Record<Mode, string> = { single: 'Single', clarify: 'Team · Clarify', verify: 'Team · Verify', compare: 'Team · Compare' };

export const PREVIOUS_LABEL: Record<Period, string> = { today: 'hôm qua cùng giờ', '24h': '24h trước đó', '7d': '7 ngày trước đó', '30d': '30 ngày trước đó', '60d': '60 ngày trước đó' };

export const STAGE_LABEL: Record<string, string> = { prepare: 'Chuẩn bị', implement: 'Triển khai', repair: 'Sửa', verify: 'Kiểm chứng' };

export const ROLE_LABEL: Record<string, string> = { planner: 'Planner', author: 'Author', developer: 'Developer', verifier: 'Verifier', investigator: 'Investigator' };

export const STATUS_LABEL: Record<string, string> = { completed: 'Đã nghiệm thu', awaiting_acceptance: 'Chờ nghiệm thu', awaiting_approval: 'Chờ duyệt hợp đồng', blocked: 'Bị chặn', failed: 'Thất bại', paused: 'Tạm dừng', running: 'Đang chạy', queued: 'Đang chờ', draft: 'Nháp' };

export const STATUS_TONE_RUN: Record<string, string> = { completed: 'good', awaiting_acceptance: 'info', awaiting_approval: 'info', blocked: 'warn', failed: 'bad', paused: 'warn', running: 'info', queued: 'info', draft: 'neutral' };

export const WAIT: Record<WaitingItem['kind'], { label: string; action: string; tone: string }> = {
  accept: { label: 'Chờ nghiệm thu', action: 'Xem & nghiệm thu', tone: 'good' },
  'approve-contract': { label: 'Chờ duyệt hợp đồng', action: 'Duyệt hợp đồng', tone: 'info' },
  'approve-policy': { label: 'Policy chưa duyệt', action: 'Duyệt policy', tone: 'info' },
  blocked: { label: 'Bị chặn', action: 'Xem lý do', tone: 'warn' },
  failed: { label: 'Thất bại', action: 'Xem lỗi', tone: 'bad' },
  paused: { label: 'Tạm dừng', action: 'Mở task', tone: 'neutral' },
};

export const WASTE_LABEL: Record<WasteItem['kind'], [string, string]> = { 'repeat-review': ['Verifier lặp', 'warn'], 'provider-error': ['Lỗi provider', 'warn'], failed: ['Lượt lỗi', 'bad'], stuck: ['Kẹt chờ bạn', 'neutral'] };

export interface ModeSummary { mode: Mode; runs: number; accepted: number; unfinished: number; escalated: number; costUsd: number; costEstimated: boolean; humanMinutesTotal: number; acceptedRate: number; costPerRun: number; humanMinutesPerRun: number; wastePerRun?: number }

export interface ContextArm { runs: number; accepted: number; acceptedRate: number; repairsPerRun: number; costPerRun: number; costEstimated: boolean }

export interface WorkspaceUsage { runId: string; title: string | null; status: string | null; updatedAt: string | null; sizeBytes: number; files: number; truncated: boolean; removable: boolean; reason: string }
export interface StorageReport { computedAt: string | null; computing: boolean; disk: Health['disk'] | null; workspaces: WorkspaceUsage[]; totalBytes: number }

export interface PreviewState { runId: string; url: string; command: string[]; stopsAt: string }

export const bytes = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(0)} MB` : n >= 1024 ? `${(n / 1024).toFixed(0)} KB` : `${n} B`);
