import { useEffect, useMemo, useState } from 'react';
import type { LiveRun, MonitorData, RequestRow, WaitingItem, WaitingKind } from '../core/monitor';
import { api } from './api';
import { LogConsole } from './Monitor';
import { RecentRequests, Topology } from './MonitorCharts';
import { MODE_LABEL } from './labels';
import type { Mode } from '../shared/types';
import { Badge, Empty, Icon, ago, duration } from './ui';

type Scope = 'running' | 'waiting' | 'errors' | 'recent';
interface Filters { project: string; query: string; scope: Scope | 'auto'; selected: string }
export const LIVE_FILTER_KEY = 'monitor.live.filters.v1';
const defaults: Filters = { project: '', query: '', scope: 'auto', selected: '' };
function storedFilters(): Filters {
  try {
    const saved = JSON.parse(localStorage.getItem(LIVE_FILTER_KEY) ?? '{}');
    return { project: typeof saved.project === 'string' ? saved.project : '', query: typeof saved.query === 'string' ? saved.query : '',
      scope: ['running', 'waiting', 'errors', 'recent'].includes(saved.scope) ? saved.scope : 'auto', selected: typeof saved.selected === 'string' ? saved.selected : '' };
  } catch { return defaults; }
}
const searchText = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
const STAGES: Record<string, string> = { prepare: 'Chuẩn bị', implement: 'Triển khai', repair: 'Sửa', verify: 'Kiểm chứng' };
const ROLES: Record<string, string> = { planner: 'Planner', author: 'Author', developer: 'Developer', verifier: 'Verifier', investigator: 'Investigator' };
const WAIT: Record<WaitingKind, { label: string; tone: string; action: string }> = {
  accept: { label: 'Chờ nghiệm thu', tone: 'good', action: 'Xem & nghiệm thu' },
  'approve-contract': { label: 'Chờ duyệt hợp đồng', tone: 'info', action: 'Duyệt hợp đồng' },
  'approve-policy': { label: 'Policy chưa duyệt', tone: 'info', action: 'Duyệt project' },
  blocked: { label: 'Bị chặn', tone: 'warn', action: 'Xem lý do' }, failed: { label: 'Thất bại', tone: 'bad', action: 'Xem lỗi' }, paused: { label: 'Tạm dừng', tone: 'neutral', action: 'Mở task' },
};
interface TaskRow { key: string; runId?: string; projectId?: string; title: string; detail: string; label: string; tone: string; action: string; updatedAt?: string; live?: LiveRun; calls?: number }
const waitingRow = (w: WaitingItem): TaskRow => ({ key: w.runId ? `run:${w.runId}` : `project:${w.projectId}`, runId: w.runId, projectId: w.projectId, title: w.title, detail: w.detail, updatedAt: w.updatedAt, ...WAIT[w.kind] });

function TaskGroup({ title, rows, selected, projects, now, onSelect }: { title: string; rows: TaskRow[]; selected?: string; projects: Map<string, string>; now: number; onSelect: (key: string) => void }) {
  const [limit, setLimit] = useState(5);
  if (!rows.length) return null;
  return <section className="monitor-task-group" aria-label={title}>
    <div className="card-head"><h3>{title}</h3><span className="faint small">{rows.length} việc</span></div>
    <ul className="monitor-task-list">{rows.slice(0, limit).map(row => <li key={row.key}>
      <button type="button" className={`monitor-task${selected === row.key ? ' selected' : ''}`} aria-pressed={selected === row.key} onClick={() => onSelect(row.key)} aria-label={`Xem hoạt động: ${row.title}`}>
        <span className="monitor-task-top"><span className="monitor-task-title">{row.title}</span><Badge tone={row.tone} live={!!row.live}>{row.label}</Badge></span>
        <span className="monitor-task-meta">{projects.get(row.projectId ?? '') ?? row.projectId ?? 'Project chưa xác định'}{row.live ? ` · ${STAGES[row.live.stage] ?? row.live.stage} · ${row.live.role ? ROLES[row.live.role] ?? row.live.role : 'Chuẩn bị / check'}` : row.calls ? ` · ${row.calls} lượt trong lịch sử gần đây` : ''}</span>
        {row.detail && <span className="monitor-task-description">{row.detail}</span>}
        <span className="monitor-task-foot">{row.live?.attemptStartedAt ? duration(Math.max(0, now - Date.parse(row.live.attemptStartedAt))) : row.updatedAt ? ago(row.updatedAt, now) : ''}{row.live && <span>{Math.round(row.live.budgetPct * 100)}% ngân sách</span>}</span>
      </button>
    </li>)}</ul>
    {rows.length > 5 && <div className="row-actions"><span className="faint small">Đang hiện {Math.min(limit, rows.length)}/{rows.length}</span>
      {limit < rows.length && <button type="button" className="text-button" onClick={() => setLimit(n => n + 5)}>Xem thêm {Math.min(5, rows.length - limit)} việc</button>}
      {limit > 5 && <button type="button" className="text-button" onClick={() => setLimit(5)}>Thu gọn {title.toLowerCase()}</button>}
    </div>}
  </section>;
}

function TaskFocus({ row, now, refresh, onOpen }: { row: TaskRow; now: number; refresh: string; onOpen: (r: RequestRow) => void }) {
  const [tab, setTab] = useState<'requests' | 'logs'>('requests');
  const [requests, setRequests] = useState<RequestRow[] | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!row.runId || tab !== 'requests') return;
    let alive = true;
    void api<RequestRow[]>(`/api/monitor/requests?run=${encodeURIComponent(row.runId)}`).then(rows => { if (alive) { setRequests(rows); setError(''); } }).catch((e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [row.runId, tab, refresh, retry]);
  return <aside className="panel-card monitor-focus" aria-label="Chi tiết task được chọn">
    <div className="card-head"><span className="kicker">Đang xem</span><Badge tone={row.tone}>{row.label}</Badge></div>
    <h2 className="monitor-focus-title">{row.title}</h2>
    {row.detail && <p className="muted small">{row.detail}</p>}
    <a className="button small" href={row.runId ? `#/run/${row.runId}` : '#/projects'}>{row.action}</a>
    {!row.runId ? <p className="muted small">Project này chờ duyệt cấu hình. Mở project để xem và duyệt; không có log task riêng.</p> : <>
      <div className="segmented monitor-detail-tabs" role="group" aria-label="Hoạt động của task">
        <button type="button" aria-pressed={tab === 'requests'} className={tab === 'requests' ? 'active' : ''} onClick={() => setTab('requests')}>Lượt gọi AI</button>
        <button type="button" aria-pressed={tab === 'logs'} className={tab === 'logs' ? 'active' : ''} onClick={() => setTab('logs')}>Log task</button>
      </div>
      {tab === 'logs' ? <LogConsole key={row.runId} runId={row.runId} height={300}/> : error ? <div role="alert" className="banner error"><span>{error}</span><button type="button" className="text-button" onClick={() => setRetry(n => n + 1)}>Thử tải lại</button></div>
        : requests === null ? <p className="muted small">Đang tải lượt gọi của task…</p> : <><RecentRequests rows={requests} now={now} onOpen={onOpen} title="Lượt gọi của task"/>{requests.length === 40 && <p className="faint small">Hiển thị 40 lượt gần nhất của task này.</p>}</>}
    </>}
  </aside>;
}

/** The queue is the primary view; request history and logs always belong to one selected task. */
export function LiveTab({ data, now, onOpen }: { data: MonitorData; now: number; onOpen: (r: RequestRow) => void }) {
  const [filters, setFilters] = useState(storedFilters);
  useEffect(() => { try { localStorage.setItem(LIVE_FILTER_KEY, JSON.stringify(filters)); } catch { /* private mode */ } }, [filters]);
  const projects = useMemo(() => {
    const result = new Map((data.projects ?? []).map(p => [p.id, p.name]));
    for (const p of data.byProject) if (p.projectId && !result.has(p.projectId)) result.set(p.projectId, p.label);
    for (const p of [...data.live, ...data.waiting, ...data.recent]) if (p.projectId && !result.has(p.projectId)) result.set(p.projectId, p.projectId);
    return result;
  }, [data]);
  const project = projects.has(filters.project) ? filters.project : '';
  const query = searchText(filters.query.trim());
  const matches = (row: { title: string; id?: string; runId?: string; projectId?: string; detail?: string }) => (!project || row.projectId === project)
    && (!query || searchText(`${row.title} ${row.id ?? row.runId ?? ''} ${projects.get(row.projectId ?? '') ?? ''} ${row.detail ?? ''}`).includes(query));
  const live = data.live.filter(matches);
  const waiting = data.waiting.filter(matches);
  const errors = waiting.filter(w => w.kind === 'blocked' || w.kind === 'failed');
  const history = new Map<string, TaskRow>();
  for (const r of data.recent) {
    if (!matches({ ...r, title: r.runTitle })) continue;
    const old = history.get(r.runId);
    if (old) { old.calls = (old.calls ?? 0) + 1; continue; }
    history.set(r.runId, { key: `run:${r.runId}`, runId: r.runId, projectId: r.projectId, title: r.runTitle, detail: '', label: 'Gần đây', tone: 'neutral', action: 'Mở task', updatedAt: r.startedAt, calls: 1 });
  }
  const scope: Scope = filters.scope === 'auto' ? live.length ? 'running' : waiting.length ? 'waiting' : 'recent' : filters.scope;
  const groups = scope === 'running' ? [{ title: 'Đang chạy', rows: live.map((r): TaskRow => ({ key: `run:${r.id}`, runId: r.id, projectId: r.projectId, title: r.title, label: 'Đang chạy', tone: 'info', action: 'Mở task', detail: `${MODE_LABEL[r.mode as Mode] ?? r.mode}${r.lastLog ? ` · ${r.lastLog}` : ''}`, live: r })) }]
    : scope === 'recent' ? [{ title: 'Lịch sử theo task', rows: [...history.values()] }]
    : [{ title: 'Nghiệm thu', kinds: ['accept'] }, { title: 'Duyệt hợp đồng / project', kinds: ['approve-contract', 'approve-policy'] }, { title: 'Cần xử lý', kinds: ['blocked', 'failed', 'paused'] }].map(group => ({ title: group.title, rows: (scope === 'errors' ? errors : waiting).filter(w => group.kinds.includes(w.kind)).map(waitingRow) }));
  const rows = groups.flatMap(g => g.rows);
  const selected = rows.find(r => r.key === filters.selected) ?? rows[0];
  const selectedKey = selected?.key;
  useEffect(() => { if (selectedKey && filters.selected !== selectedKey) setFilters(f => ({ ...f, selected: selectedKey })); }, [selectedKey, filters.selected]);
  const refresh = data.now;
  const runningIds = new Set(data.activeRuns.filter(r => r.status === 'running').map(r => r.id));
  const running = live.filter(r => runningIds.has(r.id));
  const mapTasks = running.slice(0, 8), mapIds = new Set(mapTasks.map(r => r.id));
  const mapAttempts = data.runningAttempts.filter(a => mapIds.has(a.runId));
  const mapData: MonitorData = { ...data, tasks: mapTasks.map(r => ({ id: r.id, title: r.title, status: 'running', mode: r.mode })),
    runningAttempts: mapAttempts, recent: data.recent.filter(r => mapIds.has(r.runId)), activeRuns: data.activeRuns.filter(r => mapIds.has(r.id)),
    activity: { providers: [...new Set(mapAttempts.map(a => a.provider))], stages: project || query ? { setup: false, check: false } : data.activity.stages } };
  const filterKey = `${project}:${query}:${scope}`;
  const choose = (key: string) => setFilters(f => ({ ...f, selected: key }));
  return <div className="monitor-live">
    {data.alerts.map(a => <div key={a.text} className={`banner ${a.level === 'error' ? 'error' : 'warn'}`} role="alert"><Icon name="alert" size={16}/><span>{a.text}</span></div>)}
    <div className="monitor-live-toolbar">
      <input type="search" aria-label="Tìm task theo dõi" placeholder="Tìm tên task, mã hoặc project…" value={filters.query} onChange={e => setFilters(f => ({ ...f, query: e.target.value }))}/>
      <select aria-label="Lọc project theo dõi" value={project} onChange={e => setFilters(f => ({ ...f, project: e.target.value, selected: '' }))}><option value="">Mọi project</option>{[...projects].map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
    </div>
    <div className="monitor-queue-tabs" role="group" aria-label="Lọc tình trạng theo dõi">{([['running', 'Đang chạy', live.length], ['waiting', 'Chờ bạn', waiting.length], ['errors', 'Lỗi / bị chặn', errors.length], ['recent', 'Gần đây', history.size]] as const).map(([key, label, count]) => <button type="button" key={key} className={scope === key ? 'active' : ''} aria-pressed={scope === key} onClick={() => setFilters(f => ({ ...f, scope: key, selected: '' }))}><span>{label}</span><strong>{count}</strong></button>)}</div>
    {!data.live.length && <p className="muted small monitor-idle">Hiện không có task đang chạy.{waiting.length ? ' Ưu tiên các việc đang chờ bạn bên dưới.' : ''}</p>}
    <section className="monitor-live-map" aria-label="Sơ đồ task đang hoạt động"><p className="muted small">Sơ đồ hoạt động · Chỉ hiển thị task đang chạy{running.length > 8 ? ` · ${mapTasks.length}/${running.length} task, xem đầy đủ trong danh sách` : ''}.</p><Topology data={mapData}/></section>
    <div className="monitor-live-workspace">
      <div className={`panel-card monitor-queue${rows.length ? '' : ' is-empty'}`} aria-label="Danh sách task theo dõi">
        {scope === 'recent' && <p className="muted small">Gom theo task từ 80 lượt gọi gần nhất. Chọn một task để tải lịch sử riêng của task đó.</p>}
        {!rows.length ? <Empty title="Không có việc khớp bộ lọc">{project || query ? <><span>Thử project hoặc từ khóa khác. </span><button type="button" className="button" onClick={() => setFilters(f => ({ ...f, project: '', query: '', scope: 'auto', selected: '' }))}>Xóa bộ lọc</button></> : scope === 'running' ? 'Chưa có task đang chạy.' : scope === 'errors' ? 'Không có task lỗi hoặc bị chặn.' : 'Không có việc trong nhóm này.'}</Empty>
          : groups.map(g => <TaskGroup key={`${filterKey}:${g.title}`} title={g.title} rows={g.rows} selected={selected?.key} projects={projects} now={now} onSelect={choose}/>)}
      </div>
      {selected ? <TaskFocus key={selected.key} row={selected} now={now} refresh={refresh} onOpen={onOpen}/> : <aside className="panel-card monitor-focus monitor-focus-empty"><h2>Hoạt động theo task</h2><p className="muted small">Chọn một task trong danh sách để xem lượt gọi AI và log riêng.</p></aside>}
    </div>
  </div>;
}
