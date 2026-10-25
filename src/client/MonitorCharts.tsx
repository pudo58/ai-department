import { useEffect, useState } from 'react';
import type { Bucket, MonitorData, Period, RequestRow } from '../core/monitor';
import { api } from './api';
import { Badge, Modal, ago, count, duration, money } from './ui';
import type { LogLevel } from './Monitor';

export function AttemptDetail({ attempt, onClose }: { attempt: RequestRow; onClose: () => void }) {
  const [data, setData] = useState<{ lines: { level: LogLevel; text: string }[]; raw: string } | null>(null);
  const [error, setError] = useState('');
  const [showRaw, setShowRaw] = useState(false);
  useEffect(() => { api<{ lines: { level: LogLevel; text: string }[]; raw: string }>(`/api/runs/${attempt.runId}/attempts/${attempt.id}/raw`).then(setData).catch((e: Error) => setError(e.message)); }, [attempt]);
  return <Modal title={`${attempt.role} · ${attempt.runTitle}`} subtitle={`${attempt.provider}/${attempt.model} · phương án ${attempt.slot} · giai đoạn ${attempt.stage}`} onClose={onClose}>
    {attempt.error && <p className="inline-error">{attempt.error}</p>}
    {error ? <p className="muted">{error} {attempt.status === 'running' && 'Log thô được lưu khi attempt kết thúc; xem log trực tiếp ở Console Log.'}</p> : !data ? <p className="muted">Đang tải…</p> : <>
      <div className="row-actions"><button className="text-button" onClick={() => setShowRaw((v) => !v)}>{showRaw ? 'Xem bản dễ đọc' : 'Xem JSONL thô'}</button></div>
      {showRaw ? <pre className="diff">{data.raw}</pre> : <div className="console" style={{ height: 380 }}>{data.lines.map((l, i) => <div key={i} className={`log-line plain level-${l.level}`}><span className="log-msg">{l.text}</span></div>)}</div>}</>}
  </Modal>;
}

/**
 * Live call map: tasks (callers) on the left of an orbit, executors on the right, AI Department in the middle.
 * Connections carrying work right now glow with particles travelling along them and a label (role · time);
 * connections used in the last 10 minutes stay as faint traces. Idle nodes sit quietly on the orbit.
 */
export function Topology({ data }: { data: MonitorData }) {
  const [zoom, setZoom] = useState(1);
  const idle = data.tasks.length === 0;
  const W = 880, H = idle ? 300 : 480, cx = W / 2, cy = H / 2 + 10, rx = 330, ry = idle ? 92 : 178;
  const now = Date.parse(data.now);
  const orbit = (n: number, from: number, to: number) => Array.from({ length: n }, (_, i) => {
    const deg = n === 1 ? (from + to) / 2 : from + ((to - from) * i) / (n - 1);
    const rad = (deg * Math.PI) / 180;
    return { x: cx + rx * Math.cos(rad), y: cy + ry * Math.sin(rad) };
  });
  const running = data.runningAttempts;
  const modelOf = (provider: string) => { const m = running.find((a) => a.provider === provider)?.model; return m && m !== 'default' ? m : undefined; };
  const recently = (pred: (r: RequestRow) => boolean) => data.recent.some((r) => pred(r) && r.endedAt && now - Date.parse(r.endedAt) < RECENT_MS);
  const services = [
    { id: 'codex', label: 'Codex CLI', live: data.activity.providers.includes('codex'), recent: recently((r) => r.provider === 'codex'), model: modelOf('codex') },
    { id: 'claude', label: 'Claude Code', live: data.activity.providers.includes('claude'), recent: recently((r) => r.provider === 'claude'), model: modelOf('claude') },
    // Shown only once a run has used it, so the map stays as it was for people without Antigravity.
    ...(data.recent.some((r) => r.provider === 'antigravity') || data.activity.providers.includes('antigravity')
      ? [{ id: 'antigravity', label: 'Antigravity', live: data.activity.providers.includes('antigravity'), recent: recently((r) => r.provider === 'antigravity'), model: modelOf('antigravity') }] : []),
    { id: 'check', label: 'Check / test', live: data.activity.stages.check, recent: false },
    { id: 'setup', label: 'Git · cài đặt', live: data.activity.stages.setup, recent: false },
  ];
  const tasks = data.tasks.map((t) => {
    const attempt = running.find((a) => a.runId === t.id);
    return { ...t, live: t.status === 'running' || t.status === 'queued', attempt, recent: recently((r) => r.runId === t.id) };
  });
  const taskPos = orbit(tasks.length, 116, 244);
  const svcPos = orbit(services.length, -50, 50);
  const liveTasks = tasks.filter((t) => t.live), liveSvcs = services.filter((s) => s.live);
  const anyLive = liveTasks.length > 0 || liveSvcs.length > 0;
  const lastCall = data.recent.find((r) => r.endedAt)?.endedAt;

  const cut = (s: string, n = 22) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const chipW = (label: string, icon: boolean) => Math.max(104, Math.min(232, (icon ? 44 : 34) + label.length * 6.9));
  const left = (x: number, w: number) => Math.min(Math.max(x - w / 2, 8), W - w - 8);
  const hubW = 176, hubH = 62;
  type Pt = { x: number; y: number };
  const ctrl = (a: Pt, b: Pt): [Pt, Pt] => { const mx = (a.x + b.x) / 2; return [{ x: mx, y: a.y }, { x: mx, y: b.y }]; };
  const pathOf = (a: Pt, b: Pt) => { const [c1, c2] = ctrl(a, b); return `M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}`; };
  const mid = (a: Pt, b: Pt): Pt => { const [c1, c2] = ctrl(a, b); return { x: (a.x + 3 * c1.x + 3 * c2.x + b.x) / 8, y: (a.y + 3 * c1.y + 3 * c2.y + b.y) / 8 }; };
  const statusColor = (t: { live: boolean; status: string }) => STATUS_DOT[t.live ? 'running' : t.status === 'completed' ? 'completed' : t.status === 'failed' ? 'failed' : 'interrupted'];
  const hubIn = { x: cx - hubW / 2, y: cy }, hubOut = { x: cx + hubW / 2, y: cy };

  type Edge = { id: string; d: string; kind: 'live' | 'wait' | 'recent'; label?: string; at: Pt };
  const edges: Edge[] = [];
  tasks.forEach((t, i) => {
    if (!t.live && !t.recent) return;
    const p = taskPos[i]!, w = chipW(cut(t.title), false), a = { x: left(p.x, w) + w, y: p.y };
    const label = t.attempt ? `${t.attempt.role} · ${duration(now - Date.parse(t.attempt.startedAt))}` : t.status === 'queued' ? 'đang chờ' : undefined;
    edges.push({ id: `te-${t.id}`, d: pathOf(a, hubIn), kind: t.live ? (t.status === 'queued' ? 'wait' : 'live') : 'recent', label: t.live ? label : undefined, at: mid(a, hubIn) });
  });
  services.forEach((s, i) => {
    if (!s.live && !s.recent) return;
    const label = s.model ? `${s.label} · ${s.model}` : s.label;
    const p = svcPos[i]!, w = chipW(label, true), b = { x: left(p.x, w), y: p.y };
    edges.push({ id: `se-${s.id}`, d: pathOf(hubOut, b), kind: s.live ? 'live' : 'recent', at: mid(hubOut, b) });
  });

  return <div className={`topology map2 ${anyLive ? 'is-live' : ''}${idle ? ' is-idle' : ''}`} role="img" aria-label={`Sơ đồ gọi: ${liveTasks.length} task đang chạy, ${liveSvcs.length} dịch vụ đang được gọi`}>
    <div className="map-head">
      <span className={`map-state ${anyLive ? 'on' : ''}`}><span className="map-dot"/>{anyLive
        ? `Đang gọi ${liveSvcs.map((s) => (s.model ? `${s.label} · ${s.model}` : s.label)).join(', ') || 'chuẩn bị'} cho ${liveTasks.length} task`
        : lastCall ? `Nhàn rỗi · lần gọi gần nhất ${ago(lastCall, now)}` : 'Nhàn rỗi'}</span>
      <span className="map-legend"><span><i className="lg-live"/>đang chạy</span><span><i className="lg-recent"/>vừa gọi (10 phút)</span><span><i style={{ background: STATUS_DOT.completed }}/>xong</span><span><i style={{ background: STATUS_DOT.failed }}/>lỗi</span></span>
    </div>
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="map-flow" x1="0" x2="1" y1="0" y2="0"><stop offset="0" className="stop-a"/><stop offset="1" className="stop-b"/></linearGradient>
        <radialGradient id="map-hub" cx="50%" cy="30%" r="80%"><stop offset="0" className="hub-stop-a"/><stop offset="1" className="hub-stop-b"/></radialGradient>
        <filter id="map-glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="3.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      </defs>
      <g transform={`translate(${cx} ${cy}) scale(${zoom}) translate(${-cx} ${-cy})`}>
        <ellipse cx={cx} cy={cy} rx={rx} ry={ry} className="map-orbit"/>
        <ellipse cx={cx} cy={cy} rx={rx * 0.55} ry={ry * 0.55} className="map-orbit inner"/>
        {edges.map((e) => <g key={e.id} className={`map-edge ${e.kind}`}>
          {e.kind !== 'recent' && <path d={e.d} className="edge-halo"/>}
          <path id={e.id} d={e.d} className="edge-line"/>
          {e.kind !== 'recent' && [0, 0.55, 1.1].map((delay) => <circle key={delay} r="3.4" className="edge-dot" filter="url(#map-glow)">
            <animateMotion dur={e.kind === 'wait' ? '3.2s' : '1.65s'} begin={`-${delay}s`} repeatCount="indefinite" rotate="auto"><mpath href={`#${e.id}`}/></animateMotion>
          </circle>)}
          {e.label && <g className="edge-tag" transform={`translate(${e.at.x} ${e.at.y - 14})`}><rect x={-(e.label.length * 3.3 + 10)} y="-10" width={e.label.length * 6.6 + 20} height="20" rx="10"/><text textAnchor="middle" y="4">{e.label}</text></g>}
        </g>)}
        {tasks.map((t, i) => {
          const p = taskPos[i]!, label = cut(t.title), w = chipW(label, false);
          return <a key={t.id} href={`#/run/${t.id}`}>
            <g className={`chip2 ${t.live ? 'live' : t.recent ? 'recent' : ''}`} transform={`translate(${left(p.x, w)} ${p.y - 15})`}>
              <rect width={w} height="30" rx="15"/>
              <circle cx="16" cy="15" r="5.5" className="ring" style={{ stroke: statusColor(t) }}/><circle cx="16" cy="15" r="2.6" style={{ fill: statusColor(t) }}/>
              <text x="29" y="19">{label}</text>
              <title>{`${t.title} · ${t.status}${t.attempt ? ` · đang chạy ${t.attempt.role}` : ''}`}</title>
            </g></a>;
        })}
        {services.map((s, i) => {
          const p = svcPos[i]!, label = s.model ? `${s.label} · ${s.model}` : s.label, w = chipW(label, true);
          return <g key={s.id} className={`chip2 svc ${s.live ? 'live' : s.recent ? 'recent' : ''}`} transform={`translate(${left(p.x, w)} ${p.y - 15})`}>
            <rect width={w} height="30" rx="15"/>
            <rect x="5" y="5" width="20" height="20" rx="10" className="glyph-bg"/>
            <svg x="8" y="8" width="14" height="14" viewBox="0 0 24 24" className="glyph"><path d={GLYPH[s.id]}/></svg>
            <text x="33" y="19">{label}</text>
            <title>{s.live ? `${label}: đang được gọi` : s.recent ? `${label}: vừa được gọi` : `${label}: không hoạt động`}</title>
          </g>;
        })}
        <g className={`hub2 ${anyLive ? 'live' : ''}`}>
          {anyLive && [0, 1].map((k) => <ellipse key={k} cx={cx} cy={cy} rx={hubW / 2 + 6} ry={hubH / 2 + 6} className="radar" style={{ animationDelay: `${k * 1.3}s` }}/>)}
          <rect x={cx - hubW / 2} y={cy - hubH / 2} width={hubW} height={hubH} rx="18" fill="url(#map-hub)" className="hub-body"/>
          <svg x={cx - hubW / 2 + 14} y={cy - 11} width="22" height="22" viewBox="0 0 24 24" className="glyph hub-glyph"><path d={GLYPH.hub}/></svg>
          <text x={cx - hubW / 2 + 44} y={cy - 2} className="hub-title">AI Department</text>
          <text x={cx - hubW / 2 + 44} y={cy + 14} className="hub-sub">{anyLive ? `${liveTasks.length} task · ${liveSvcs.length} dịch vụ` : 'chờ việc'}</text>
        </g>
      </g>
    </svg>
    <div className="zoom-controls">
      <button aria-label="Phóng to" onClick={() => setZoom((z) => Math.min(1.6, +(z + 0.15).toFixed(2)))}>+</button>
      <button aria-label="Thu nhỏ" onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.15).toFixed(2)))}>−</button>
      <button aria-label="Về mặc định" onClick={() => setZoom(1)}>⛶</button>
    </div>
    {!tasks.length && <p className="topology-empty">Không có task đang chạy trong bộ lọc. Luồng hoạt động sẽ hiện khi task bắt đầu.</p>}
  </div>;
}

export function TokenChart({ series, unit }: { series: Bucket[]; unit: 'hour' | 'day' }) {
  const W = 900, H = 230, left = 52, bottom = 26, top = 12;
  const max = Math.max(1, ...series.map((b) => b.inputTokens + b.outputTokens));
  const bw = (W - left - 8) / Math.max(1, series.length);
  const y = (v: number) => top + (H - top - bottom) * (1 - v / max);
  const label = (iso: string) => { const d = new Date(iso); return unit === 'hour' ? `${String(d.getHours()).padStart(2, '0')}:00` : `${d.getDate()}/${d.getMonth() + 1}`; };
  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f));
  const every = Math.max(1, Math.ceil(series.length / 10));
  const compact = (n: number) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  return <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Token theo thời gian">
    {ticks.map((t) => <g key={t}><line x1={left} x2={W - 8} y1={y(t)} y2={y(t)} className="grid-line"/><text x={left - 8} y={y(t) + 4} textAnchor="end" className="axis">{compact(t)}</text></g>)}
    {series.map((b, i) => {
      const uncached = Math.max(0, b.inputTokens - b.cachedTokens);
      const x = left + i * bw + bw * 0.14, w = Math.max(2, bw * 0.72);
      let top0 = y(0);
      const seg = (v: number, cls: string) => { const h = (H - top - bottom) * (v / max); top0 -= h; return v > 0 ? <rect x={x} y={top0} width={w} height={h} className={cls} rx="1.5"/> : null; };
      return <g key={b.t}>
        {seg(uncached, 'bar-in')}{seg(b.cachedTokens, 'bar-cache')}{seg(b.outputTokens, 'bar-out')}
        <rect x={left + i * bw} y={top} width={bw} height={H - top - bottom} fill="transparent"><title>{`${label(b.t)} · ${b.requests} lượt · vào ${num(b.inputTokens)} (cache ${num(b.cachedTokens)}) · ra ${num(b.outputTokens)} · ~${money(b.costUsd)}`}</title></rect>
        {i % every === 0 && <text x={x + w / 2} y={H - 8} textAnchor="middle" className="axis">{label(b.t)}</text>}
      </g>;
    })}
  </svg>;
}

/** Axis ticks from 0 to a round maximum (1, 2, 2.5 or 5 times a power of ten per step), so labels read $5, $10, not $9.256. */
export function niceTicks(max: number, count = 4): number[] {
  const raw = Math.max(max, Number.EPSILON) / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw)!;
  const top = Math.ceil(max / step - 1e-9) * step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => +(i * step).toPrecision(12));
}

/** Stacked bars over time: tokens by kind, cost by agent role, or plain request counts. */
export function MetricChart({ series, unit, metric }: { series: Bucket[]; unit: 'hour' | 'day'; metric: ChartMetric }) {
  const W = 900, H = 230, left = 56, bottom = 26, top = 12;
  const roles = [...new Set(series.flatMap((b) => Object.keys(b.costByRole ?? {})))].sort((a, b) => Object.keys(ROLE_COLOR).indexOf(a) - Object.keys(ROLE_COLOR).indexOf(b));
  const stacks = (b: Bucket): { v: number; color: string; name: string }[] => metric === 'tokens'
    ? [{ v: Math.max(0, b.inputTokens - b.cachedTokens), color: 'var(--c-in)', name: 'vào' }, { v: b.cachedTokens, color: 'var(--c-cache)', name: 'cache' }, { v: b.outputTokens, color: 'var(--c-out)', name: 'ra' }]
    : metric === 'cost' ? roles.map((r) => ({ v: b.costByRole?.[r] ?? 0, color: ROLE_COLOR[r] ?? 'var(--text-3)', name: ROLE_NAME[r] ?? r }))
      : [{ v: b.requests, color: 'var(--accent)', name: 'lượt' }];
  const totalOf = (b: Bucket) => stacks(b).reduce((s, x) => s + x.v, 0);
  // An empty period gets a sentence, not a full-size grid of nothing.
  if (!series.some((b) => totalOf(b) > 0)) return <p className="chart-empty">Chưa có {metric === 'tokens' ? 'token' : metric === 'cost' ? 'chi phí' : 'lượt gọi'} nào trong kỳ này.</p>;
  const ticks = niceTicks(Math.max(...series.map(totalOf)));
  const max = ticks.at(-1)!;
  const bw = (W - left - 8) / Math.max(1, series.length);
  const y = (v: number) => top + (H - top - bottom) * (1 - v / max);
  const label = (iso: string) => { const d = new Date(iso); return unit === 'hour' ? `${String(d.getHours()).padStart(2, '0')}:00` : `${d.getDate()}/${d.getMonth() + 1}`; };
  const fmt = (n: number) => (metric === 'cost' ? money(n) : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n));
  const every = Math.max(1, Math.ceil(series.length / 10));
  return <>
    {metric === 'cost' && roles.length > 0 && <div className="legend chart-legend">{roles.map((r) => <span key={r}><i className="sw" style={{ background: ROLE_COLOR[r] ?? 'var(--text-3)' }}/>{ROLE_NAME[r] ?? r}</span>)}</div>}
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={`${metric === 'tokens' ? 'Token' : metric === 'cost' ? 'Chi phí' : 'Lượt gọi'} theo thời gian`}>
      {ticks.map((v) => <g key={v}><line x1={left} x2={W - 8} y1={y(v)} y2={y(v)} className="grid-line"/><text x={left - 8} y={y(v) + 4} textAnchor="end" className="axis">{fmt(v)}</text></g>)}
      {series.map((b, i) => {
        const x = left + i * bw + bw * 0.14, w = Math.max(2, bw * 0.72);
        let top0 = y(0);
        const parts = stacks(b);
        return <g key={b.t}>
          {parts.map((p) => { const h = (H - top - bottom) * (p.v / max); top0 -= h; return p.v > 0 ? <rect key={p.name} x={x} y={top0} width={w} height={h} rx="1.5" style={{ fill: p.color }}/> : null; })}
          <rect x={left + i * bw} y={top} width={bw} height={H - top - bottom} fill="transparent"><title>{`${label(b.t)} · ${parts.filter((p) => p.v > 0).map((p) => `${p.name} ${fmt(p.v)}`).join(' · ') || 'không có'}`}</title></rect>
          {i % every === 0 && <text x={x + w / 2} y={H - 8} textAnchor="middle" className="axis">{label(b.t)}</text>}
        </g>;
      })}
    </svg>
  </>;
}

export function RecentRequests({ rows, now, onOpen, title = 'Lượt gọi gần đây' }: { rows: RequestRow[]; now: number; onOpen: (r: RequestRow) => void; title?: string }) {
  const shown = rows.slice(0, 40);
  return <div className="recent">
    <div className="recent-head"><h3>{title}</h3>{shown.length > 0 && <span className="faint small">token vào → ra</span>}</div>
    <div className="recent-scroll">
      {!shown.length ? <p className="muted small">Chưa có lượt gọi nào.</p> : <ol className="call-list">{shown.map((r) => <li key={r.id}>
        <button type="button" className="call-row" onClick={() => onOpen(r)} title={`${r.runTitle} · ${r.role}/${r.slot} · ${r.model} · vào ${num(r.inputTokens)} · ra ${num(r.outputTokens)}`}>
          <span className="call-dot" style={{ background: STATUS_DOT[r.status] ?? 'var(--text-3)' }}/>
          <span className="call-main"><span className="call-role">{ROLE_NAME[r.role] ?? r.role}</span><span className="call-model">{r.model === 'default' ? 'model mặc định' : r.model}</span></span>
          <span className="call-io">{count(r.inputTokens)}<span className="call-arrow">→</span>{count(r.outputTokens)}</span>
          <span className="call-time">{r.status === 'running' ? <Badge tone="info" live>đang chạy</Badge> : short(ago(r.startedAt, now))}</span>
        </button></li>)}</ol>}
    </div>
  </div>;
}

export const STATUS_TONE: Record<string, string> = { running: 'info', completed: 'good', failed: 'bad', interrupted: 'warn' };

export const STATUS_DOT: Record<string, string> = { running: 'var(--live)', completed: 'var(--c-out)', failed: 'var(--bad)', interrupted: 'var(--warn)' };

export const PERIOD_LABEL: Record<Period, string> = { today: 'Hôm nay', '24h': '24h', '7d': '7D', '30d': '30D', '60d': '60D' };

export const ROLE_COLOR: Record<string, string> = { developer: 'var(--role-developer)', verifier: 'var(--role-verifier)', planner: 'var(--role-planner)', author: 'var(--role-author)', investigator: 'var(--role-investigator)' };

export const time = (iso: string) => new Date(iso).toLocaleTimeString('vi-VN', { hour12: false });

export const num = (n: number) => n.toLocaleString('en-US');

/** "5 phút trước" -> "5p trước" for narrow columns. */
export const short = (s: string) => s.replace(' phút trước', 'p trước').replace(' giờ trước', 'g trước').replace(' ngày trước', 'n trước');

/** Small line icons drawn inside the map (24×24 grid, stroke = currentColor). */
export const GLYPH: Record<string, string> = {
  codex: 'M4 6.5 9.5 12 4 17.5M12 18h8',
  claude: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z',
  antigravity: 'M12 3 4.5 21M12 3l7.5 18M7.6 14h8.8',
  check: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM8 12.5l2.8 2.8L16.5 9',
  setup: 'M6 3v12M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9a9 9 0 0 1-9 9',
  hub: 'm12 3 9 5-9 5-9-5Zm-9 9 9 5 9-5m-18 4 9 5 9-5',
};

export const RECENT_MS = 10 * 60_000;

export type ChartMetric = 'tokens' | 'cost' | 'requests';

export const ROLE_NAME: Record<string, string> = { developer: 'Developer', verifier: 'Verifier', planner: 'Planner', author: 'Author', investigator: 'Investigator' };
