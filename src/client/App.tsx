import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Health, ProjectProfile, RunSummary } from '../shared/types';
import { api } from './api';
import { ProjectEditForm, ProjectForm, RunForm } from './forms';
import { ProjectContext } from './ProjectContext';
import { ACTIVE, MODE_LABEL, NEEDS_YOU, runStatus, pipelineStep, STEPS } from './labels';
import { MonitorHub, normalizeMonitorTab, type MonitorTab } from './MonitorHub';
import { ConnectPage } from './ConnectPage';
import { SkillsPage } from './SkillsPage';
import { McpPage } from './McpPage';
import { PROVIDER_LABEL } from '../shared/providers';
import { humanizeTestIds } from '../core/testids';
import { DeleteRunDialog, RunPage } from './RunPage';
import { Badge, ConfirmDialog, Empty, Icon, PageHeader, Pager, ThemeSwitch, ago, money, type Hue, type IconName } from './ui';
import { PAGE_SIZES, clampPage, pageSlice } from './paging';

type View = { name: 'runs' } | { name: 'run'; id: string } | { name: 'projects' } | { name: 'skills' } | { name: 'mcp' } | { name: 'connect' } | { name: 'monitor'; tab: MonitorTab };

const parseHash = (): View => {
  const [, name, arg] = window.location.hash.split('/');
  if (name === 'run' && arg) return { name: 'run', id: arg };
  if (name === 'projects') return { name: 'projects' };
  if (name === 'connect') return { name: 'connect' };
  if (name === 'skills') return { name: 'skills' };
  if (name === 'mcp') return { name: 'mcp' };
  if (name === 'monitor') return { name: 'monitor', tab: normalizeMonitorTab(arg) };
  // Links from before the pages were merged.
  if (name === 'console') return { name: 'monitor', tab: 'overview' };
  if (name === 'metrics') return { name: 'monitor', tab: 'cost' };
  if (name === 'system') return { name: 'monitor', tab: 'system' };
  return { name: 'runs' };
};
const hashOf = (view: View) => (view.name === 'runs' ? '#/' : view.name === 'run' ? `#/run/${view.id}` : view.name === 'monitor' ? (view.tab === 'overview' ? '#/monitor' : `#/monitor/${view.tab}`) : view.name === 'connect' ? '#/connect' : view.name === 'skills' ? '#/skills' : view.name === 'mcp' ? '#/mcp' : '#/projects');

const SIDEBAR_KEY = 'aidept-sidebar';

export function App() {
  const [view, setView] = useState<View>(parseHash);
  const [projects, setProjects] = useState<ProjectProfile[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState('');
  const [modal, setModal] = useState<'project' | 'run' | null>(null);
  const [editing, setEditing] = useState<ProjectProfile | null>(null);
  const [contextFor, setContextFor] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ run: RunSummary } | { project: ProjectProfile } | null>(null);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(SIDEBAR_KEY) === 'collapsed'; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem(SIDEBAR_KEY, collapsed ? 'collapsed' : 'open'); } catch { /* storage can be unavailable */ } }, [collapsed]);

  const go = (next: View) => { window.location.hash = hashOf(next); };
  useEffect(() => { const sync = () => setView(parseHash()); window.addEventListener('hashchange', sync); return () => window.removeEventListener('hashchange', sync); }, []);

  const load = useCallback(async () => {
    try { const [p, r] = await Promise.all([api<ProjectProfile[]>('/api/projects'), api<RunSummary[]>('/api/runs')]); setProjects(p); setRuns([...r].reverse()); setError(''); }
    catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 3000); return () => clearInterval(t); }, [load]);
  useEffect(() => { const check = () => api<Health>('/api/health').then(setHealth).catch(() => setHealth(null)); void check(); const t = setInterval(() => void check(), 60_000); return () => clearInterval(t); }, []);

  async function save(path: string, body: unknown, after?: (result: { id: string }) => void, method = 'POST') {
    setBusy(true);
    try { const result = await api<{ id: string }>(path, method, body); setModal(null); await load(); after?.(result); }
    finally { setBusy(false); }
  }

  const waiting = runs.filter((r) => inFilter(r, 'attention')).length;
  const nav: [string, string, IconName, number | undefined][] = [['runs', 'Công việc', 'flow', waiting || undefined], ['projects', 'Dự án', 'folder', undefined], ['skills', 'Skill', 'layers', undefined], ['monitor', 'Theo dõi', 'activity', undefined], ['mcp', 'MCP', 'terminal', undefined], ['connect', 'Kết nối AI', 'shield', undefined]];
  const current = view.name === 'run' ? 'runs' : view.name;
  const ready = health?.liveReady;
  return <div className={`app-shell${collapsed ? ' collapsed' : ''}`}>
    <aside className="sidebar" aria-label="Thanh bên">
      <div className="brand-row">
        <a className="brand" href="#/" aria-label="AI Department"><span className="brand-mark" aria-hidden="true">AD</span><span className="name">AI Department</span></a>
        <button className="icon-button collapse" onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? 'Mở rộng thanh bên' : 'Thu gọn thanh bên'} title={collapsed ? 'Mở rộng' : 'Thu gọn'}><Icon name={collapsed ? 'chevron' : 'back'} size={16}/></button>
      </div>
      <nav className="nav" aria-label="Điều hướng chính">{nav.map(([name, label, icon, n]) => <button key={name} className={`nav-link ${current === name ? 'active' : ''}`} aria-current={current === name ? 'page' : undefined} title={collapsed ? label : undefined}
        onClick={() => go(name === 'monitor' ? { name: 'monitor', tab: 'overview' } : { name } as View)}><Icon name={icon} size={16}/><span className="lbl">{label}</span>{n ? <span className="count" title={`${n} việc đang chờ bạn`}>{n}</span> : null}</button>)}</nav>
      {projects.length > 0 && <div className="side-section">
        <span className="side-label">Dự án</span>
        {projects.slice(0, 8).map((p) => <a key={p.id} className="side-item" href="#/projects" title={p.repository}>
          <span className={`side-dot ${p.approved ? 'ok' : 'warn'}`} aria-hidden="true"/><span className="side-name">{p.name}</span></a>)}
      </div>}
      <div className="sidebar-foot">
        <button className="health-pill" onClick={() => go({ name: 'connect' })} title={health ? (ready ? 'Có thể chạy thật. Bấm để xem kết nối Codex / Claude / Antigravity' : 'Chưa chạy thật được. Bấm để kết nối một AI') : 'Đang kiểm tra hệ thống'}>
          <span className={`dot ${health ? (ready ? 'dot-ok' : 'dot-warn') : ''}`}/><span className="label">{health ? (ready ? 'Sẵn sàng' : 'Chưa sẵn sàng') : 'Đang kiểm tra'}</span></button>
        <ThemeSwitch/>
      </div>
    </aside>
    <main className="container">
      {error && <div className="banner error" role="alert"><Icon name="alert" size={16}/><span>{error}</span></div>}
      {view.name === 'runs' && <WorkView runs={runs} projects={projects} onOpen={(id) => go({ name: 'run', id })} onCreate={() => setModal('run')} onAddProject={() => go({ name: 'projects' })} onDelete={(run) => setDeleting({ run })}/>}
      {view.name === 'run' && <RunPage key={view.id} id={view.id} onBack={() => go({ name: 'runs' })} onDeleted={async () => { go({ name: 'runs' }); await load(); }}/>}
      {view.name === 'projects' && <ProjectsView projects={projects} runs={runs} onEdit={setEditing} onContext={(p) => setContextFor(p.id)} onCreate={() => setModal('project')} onDelete={(project) => setDeleting({ project })} onApprove={async (id) => { await api(`/api/projects/${id}/approve`, 'POST', {}); await load(); }}/>}
      {view.name === 'skills' && <SkillsPage/>}
      {view.name === 'mcp' && <McpPage/>}
      {view.name === 'connect' && <ConnectPage projects={projects} onProjectsChanged={load}/>}
      {view.name === 'monitor' && <MonitorHub tab={view.tab} onTab={(tab) => go({ name: 'monitor', tab })}/>}
    </main>
    {editing && <ProjectEditForm project={editing} busy={busy} onClose={() => setEditing(null)} onSave={async (body) => { await save('/api/projects/' + editing.id, body, undefined, 'PATCH'); setEditing(null); }}/>}
    {contextFor && projects.find((p) => p.id === contextFor) && <ProjectContext project={projects.find((p) => p.id === contextFor)!} onClose={() => setContextFor(null)} onProjectSaved={load}/>}
    {modal === 'project' && <ProjectForm busy={busy} onClose={() => setModal(null)} onSave={(body) => save('/api/projects', body)}/>}
    {modal === 'run' && <RunForm projects={projects} busy={busy} onClose={() => setModal(null)} onSave={(body) => save('/api/runs', body, (r) => go({ name: 'run', id: r.id }))}/>}
    {deleting && 'run' in deleting && <DeleteRunDialog run={deleting.run} onClose={() => setDeleting(null)} onDeleted={async () => { setDeleting(null); await load(); }}/>}
    {deleting && 'project' in deleting && <ConfirmDialog title={`Xoá dự án ${deleting.project.name}?`} confirmLabel="Xoá dự án"
      disabled={runs.some((r) => r.projectId === deleting.project.id && (ACTIVE.includes(r.status) || r.deliveryStatus === 'in_progress'))}
      onClose={() => setDeleting(null)} onConfirm={async () => { await api(`/api/projects/${deleting.project.id}`, 'DELETE'); setDeleting(null); await load(); }}>
      <ProjectDeleteNote project={deleting.project} runs={runs.filter((r) => r.projectId === deleting.project.id)}/>
    </ConfirmDialog>}
  </div>;
}

/** What deleting a project takes with it, and what it leaves alone. */
function ProjectDeleteNote({ project, runs }: { project: ProjectProfile; runs: RunSummary[] }) {
  const working = runs.filter((r) => ACTIVE.includes(r.status) || r.deliveryStatus === 'in_progress').length;
  return <>
    <p>{runs.length ? <>Xoá cả <strong>{runs.length} việc</strong> của dự án, cùng lịch sử, log, bản sao làm việc và bộ nhớ dự án.</> : 'Dự án chưa có việc nào.'} Không hoàn tác được.</p>
    <p className="muted">Thư mục code <span className="mono">{project.repository}</span> được giữ nguyên.</p>
    {working > 0 && <p className="notice-line warn">Còn {working} việc đang chạy. Dừng chúng trước rồi mới xoá được dự án.</p>}
  </>;
}

type Filter = 'all' | 'running' | 'attention' | 'done';
const FILTERS: [Filter, string][] = [['all', 'Tất cả'], ['attention', 'Cần bạn'], ['running', 'Đang chạy'], ['done', 'Hoàn thành']];
const inFilter = (run: RunSummary, f: Filter) => f === 'all' || (f === 'running' ? ACTIVE.includes(run.status) || run.deliveryStatus === 'in_progress'
  : f === 'attention' ? run.deliveryStatus !== 'in_progress' && (NEEDS_YOU.includes(run.status) || (run.status === 'completed' && run.deliveryStatus !== 'succeeded'))
  : run.status === 'completed' && run.deliveryStatus === 'succeeded');

/**
 * What the person has to do, in order: the two decisions only they can make (accept a finished result, approve a
 * contract), then failures and blocks to step in on, then work that is merely waiting to be resumed or started.
 */
const DECISION: Partial<Record<RunSummary['status'], { label: string; action: string; icon: IconName; hue: Hue; rank: number }>> = {
  awaiting_acceptance: { label: 'Chờ nghiệm thu', action: 'Nghiệm thu', icon: 'check', hue: 'blue', rank: 0 },
  awaiting_approval: { label: 'Chờ duyệt hợp đồng', action: 'Duyệt hợp đồng', icon: 'edit', hue: 'blue', rank: 1 },
  failed: { label: 'Lỗi', action: 'Xem lỗi', icon: 'close', hue: 'red', rank: 2 },
  blocked: { label: 'Bị chặn', action: 'Gỡ chặn', icon: 'alert', hue: 'orange', rank: 3 },
  paused: { label: 'Tạm dừng', action: 'Chạy tiếp', icon: 'pause', hue: 'gray', rank: 5 },
  draft: { label: 'Nháp', action: 'Bắt đầu', icon: 'plus', hue: 'gray', rank: 6 },
};
function decisionOf(run: RunSummary) {
  if (run.deliveryStatus === 'in_progress') return undefined;
  if (run.deliveryStatus === 'failed' || run.deliveryStatus === 'unknown' || (run.status === 'completed' && run.deliveryStatus !== 'succeeded')) {
    return { label: runStatus(run).label, action: 'Thử giao lại', icon: 'alert' as const, hue: 'orange' as const, rank: 0 };
  }
  return DECISION[run.status];
}
const PRIORITY_SHOWN = 6;
/** First sentence of a blocker, short enough for one line in a list. */
const brief = (text: string | null) => {
  if (!text) return '';
  const clean = humanizeTestIds(text).replace(/^(Runtime bị chặn|Cần chú ý):\s*/i, '').replace(/\s+/g, ' ').trim();
  const cut = clean.search(/[.;](\s|$)/);
  const sentence = cut > 20 ? clean.slice(0, cut) : clean;
  return sentence.length > 110 ? `${sentence.slice(0, 109)}…` : sentence;
};
/** Who writes the code for this task: the Developer role's CLI and model. */
const agentOf = (run: RunSummary) => {
  const dev = run.developer;
  return { name: run.provider === 'fake' ? 'Mô phỏng' : PROVIDER_LABEL[dev.provider], model: dev.model || 'model mặc định' };
};

const PAGE_SIZE_KEY = 'aidept-page-size';
const readPageSize = () => { try { const n = Number(localStorage.getItem(PAGE_SIZE_KEY)); return (PAGE_SIZES as readonly number[]).includes(n) ? n : PAGE_SIZES[0]; } catch { return PAGE_SIZES[0]; } };

function WorkView({ runs, projects, onOpen, onCreate, onAddProject, onDelete }: { runs: RunSummary[]; projects: ProjectProfile[]; onOpen: (id: string) => void; onCreate: () => void; onAddProject: () => void; onDelete: (run: RunSummary) => void }) {
  const [filter, setFilterState] = useState<Filter>('all');
  const [query, setQueryState] = useState('');
  const [page, setPage] = useState(1);
  const [size, setSizeState] = useState(readPageSize);
  // A new filter, search or page size starts again from the first page.
  const setFilter = (f: Filter) => { setFilterState(f); setPage(1); };
  const setQuery = (text: string) => { setQueryState(text); setPage(1); };
  const setSize = (n: number) => { setSizeState(n); setPage(1); try { localStorage.setItem(PAGE_SIZE_KEY, String(n)); } catch { /* storage can be unavailable */ } };
  const names = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map(([f]) => [f, runs.filter((r) => inFilter(r, f)).length])) as Record<Filter, number>, [runs]);
  const q = query.trim().toLowerCase();
  const rows = runs.filter((r) => inFilter(r, filter) && (!q || r.title.toLowerCase().includes(q) || (names.get(r.projectId) ?? '').toLowerCase().includes(q)));
  // Deleting the last row of the last page lands on the page before it.
  const shownPage = clampPage(page, rows.length, size);
  const pageRows = pageSlice(rows, shownPage, size);
  const now = Date.now();
  const decisions = runs.filter((r) => decisionOf(r)).sort((a, b) => decisionOf(a)!.rank - decisionOf(b)!.rank || b.updatedAt.localeCompare(a.updatedAt));
  const unapproved = projects.filter((p) => !p.approved);
  const running = runs.filter((r) => ACTIVE.includes(r.status) || r.deliveryStatus === 'in_progress');
  const monthCost = runs.reduce((sum, r) => sum + r.monthCostUsd, 0);
  const needYou = decisions.length + unapproved.length;
  const showTable = (f: Filter) => { setFilter(f); document.getElementById('task-table')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  const kpis: [Filter, string, string, Hue][] = [
    ['attention', 'Cần xử lý', String(needYou), 'orange'], ['running', 'Đang chạy', String(running.length), 'blue'],
    ['done', 'Hoàn thành', String(counts.done), 'green'], ['all', 'Chi phí 30 ngày', money(monthCost), 'gray'],
  ];
  type Item = { key: string; href: string; icon: IconName; hue: Hue; label: string; title: string; meta: string; reason: string; action: string };
  const items: Item[] = [
    ...decisions.filter((r) => decisionOf(r)!.rank <= 1).map((r) => itemOf(r)),
    ...unapproved.map((p): Item => ({ key: p.id, href: '#/projects', icon: 'shield', hue: 'blue', label: 'Chưa duyệt policy', title: p.name, meta: `Dự án · policy v${p.version}`, reason: 'Việc chạy thật của dự án này bị chặn tới khi bạn duyệt.', action: 'Duyệt policy' })),
    ...decisions.filter((r) => decisionOf(r)!.rank > 1).map((r) => itemOf(r)),
  ];
  function itemOf(r: RunSummary): Item {
    const d = decisionOf(r)!;
    return { key: r.id, href: `#/run/${r.id}`, icon: d.icon, hue: d.hue, label: d.label, title: r.title, meta: `${names.get(r.projectId) ?? '—'} · ${agentOf(r).name} · ${ago(r.updatedAt, now)}`, reason: r.status === 'blocked' || r.status === 'failed' ? brief(r.blocker) : '', action: d.action };
  }
  return <>
    <PageHeader title="Công việc" subtitle="Theo dõi và điều phối công việc của các AI">
      <button className="button primary" onClick={onCreate} disabled={!projects.length} title={projects.length ? undefined : 'Thêm dự án trước'}><Icon name="plus" size={15}/>Giao việc</button>
    </PageHeader>
    {!projects.length ? <Empty title="Chưa có dự án nào" action={<button className="button primary" onClick={onAddProject}>Thêm dự án</button>}>Thêm thư mục code đầu tiên để bắt đầu giao việc.</Empty>
      : !runs.length ? <Empty title="Giao việc đầu tiên" action={<button className="button primary" onClick={onCreate}>Giao việc</button>}>Viết yêu cầu như nói với một đồng nghiệp.</Empty>
      : <>
        <div className="kpi-row">{kpis.map(([f, label, value, hue]) => <button key={label} className="kpi" onClick={() => showTable(f)}>
          <span className="kpi-label"><span className={`kpi-dot hue-${hue}`} aria-hidden="true"/>{label}</span><span className="kpi-value">{value}</span></button>)}</div>

        {items.length > 0 && <section className="work-section" aria-labelledby="todo-head">
          <div className="section-bar"><h2 id="todo-head">Cần bạn xử lý <span className="count-chip">{items.length}</span></h2>
            {items.length > PRIORITY_SHOWN && <button className="text-button" onClick={() => showTable('attention')}>Xem tất cả →</button>}</div>
          <ul className="priority-list">{items.slice(0, PRIORITY_SHOWN).map((it) => <li key={it.key}><a className="priority-row" href={it.href}>
            <span className={`priority-icon hue-${it.hue}`} aria-hidden="true"><Icon name={it.icon} size={15}/></span>
            <span className="priority-main">
              <span className="priority-title"><span className="t" title={it.title}>{it.title}</span><Badge tone={it.hue}>{it.label}</Badge></span>
              <span className="priority-meta">{it.meta}</span>
              {it.reason && <span className="priority-reason" title={it.reason}>{it.reason}</span>}
            </span>
            <span className="button small priority-action">{it.action}</span>
          </a></li>)}</ul>
        </section>}

        <section className="work-section" id="task-table" aria-labelledby="table-head">
          <div className="section-bar"><h2 id="table-head">Tất cả công việc</h2></div>
          <div className="table-card">
            <div className="table-toolbar">
              <div className="segmented" role="group" aria-label="Lọc công việc">{FILTERS.map(([f, label]) => <button key={f} className={filter === f ? 'active' : ''} aria-pressed={filter === f} onClick={() => setFilter(f)}>{label} <span className="n">{counts[f]}</span></button>)}</div>
              <label className="search"><Icon name="search" size={14}/><input type="search" aria-label="Tìm công việc" placeholder="Tìm công việc hoặc dự án" value={query} onChange={(e) => setQuery(e.target.value)}/></label>
            </div>
            {!rows.length ? <p className="table-empty">Không có công việc nào khớp. Bỏ bộ lọc hoặc đổi từ khoá.</p> :
              <><table className="tasks-table"><thead><tr><th>Công việc</th><th>AI phụ trách</th><th>Tiến độ</th><th>Trạng thái</th><th className="num">Chi phí</th><th className="num">Cập nhật</th><th><span className="sr-only">Xoá</span></th></tr></thead><tbody>
                {pageRows.map((run) => {
                  const spent = run.costUsd;
                  const step = pipelineStep(run);
                  const done = Math.min(step.index, STEPS.length);
                  const agent = agentOf(run);
                  return <tr key={run.id} className="clickable" onClick={() => onOpen(run.id)}>
                    <td className="task-cell"><span className="cell-title one-line" title={run.title}>{run.title}</span><span className="cell-note">{names.get(run.projectId) ?? '—'} · {MODE_LABEL[run.mode]}</span></td>
                    <td><span className="agent">{agent.name}</span><span className="cell-note one-line" title={agent.model}>{agent.model}</span></td>
                    <td><span className="progress" aria-label={`${done}/${STEPS.length} bước`}>{STEPS.map((s, i) => <i key={s} className={i < done ? 'on' : i === done && run.status !== 'completed' ? `now ${step.kind}` : ''}/>)}</span>
                      <span className="cell-note">{done >= STEPS.length ? 'Xong' : STEPS[done]}</span></td>
                    <td><Badge tone={runStatus(run).tone} live={ACTIVE.includes(run.status) || run.deliveryStatus === 'in_progress'}>{runStatus(run).label}</Badge></td>
                    <td className={`num${spent > run.budgetUsd ? ' bad-text' : ''}`} title={`Ngân sách ${money(run.budgetUsd)}`}>{money(spent)}</td>
                    <td className="num muted">{ago(run.updatedAt, now)}</td>
                    <td className="row-tools">{!ACTIVE.includes(run.status) && run.deliveryStatus !== 'in_progress' && <button className="icon-button row-delete" aria-label={`Xoá việc ${run.title}`} title="Xoá việc"
                      onClick={(e) => { e.stopPropagation(); onDelete(run); }}><Icon name="trash" size={15}/></button>}</td></tr>;
                })}
              </tbody></table>
              <Pager page={shownPage} size={size} total={rows.length} unit="việc" sizes={PAGE_SIZES} onPage={setPage} onSize={setSize}/></>}
          </div>
        </section>
      </>}
  </>;
}

function ProjectsView({ projects, runs, onCreate, onEdit, onContext, onApprove, onDelete }: { projects: ProjectProfile[]; runs: RunSummary[]; onCreate: () => void; onContext: (p: ProjectProfile) => void; onEdit: (p: ProjectProfile) => void; onApprove: (id: string) => Promise<void>; onDelete: (p: ProjectProfile) => void }) {
  const taskCount = (id: string) => runs.filter((r) => r.projectId === id).length;
  return <>
    <PageHeader title="Dự án" subtitle="Các thư mục code mà AI làm việc trên đó. Mỗi thay đổi policy cần duyệt lại."><button className="button primary" onClick={onCreate}><Icon name="plus" size={15}/>Thêm dự án</button></PageHeader>
    {!projects.length ? <Empty title="Chưa có dự án nào" action={<button className="button primary" onClick={onCreate}>Thêm dự án</button>}>Một dự án là một thư mục code trên máy này, có hoặc không có git. Nếu chưa có test runner, dùng mẫu <code>node --test</code>.</Empty>
      : <ol className="project-list">{projects.map((p) => {
        const roles = (['planner', 'developer', 'verifier'] as const).map((r) => [r, PROVIDER_LABEL[p.roles[r].provider]] as const);
        return <li className="project-entry" key={p.id}>
          <span className="project-icon" aria-hidden="true"><Icon name="folder" size={16}/></span>
          <div className="project-main">
            <div className="project-name"><h2>{p.name}</h2><Badge tone={p.approved ? 'good' : 'warn'}>{p.approved ? `Policy v${p.version}` : 'Chưa duyệt policy'}</Badge></div>
            <span className="repo mono" title={p.repository}>{p.repository}</span>
            <p className="project-summary">
              <span>{taskCount(p.id)} việc</span><span>{p.executionMode === 'local' ? 'Chạy trên máy' : 'Docker'}</span><span>{money(p.singleBudgetUsd)}/việc</span><span>{p.checks.length} check</span>{p.contextEnabled && <span>Có ngữ cảnh</span>}
              <span className="role-chips">{roles.map(([r, name]) => <span key={r} className={`role-chip provider-${p.roles[r].provider}`} title={`${r}: ${name}`}>{r === 'planner' ? 'Lập kế hoạch' : r === 'developer' ? 'Viết code' : 'Soát'} · {name}</span>)}</span>
            </p>
            <details className="project-details"><summary>Phạm vi, check và hướng dẫn</summary>
              <dl className="facts">
                <dt>Phạm vi</dt><dd className="mono">{p.modules.join('  ')}</dd>
                <dt>Check</dt><dd className="mono check-list">{p.checks.map((c) => <span key={c.id}><b>{c.id}</b>{c.required ? '' : ' (không bắt buộc)'}: {c.command.join(' ')}</span>)}</dd>
                {p.setupCommand.length > 0 && <><dt>Cài đặt</dt><dd className="mono">{p.setupCommand.join(' ')}</dd></>}
                {p.guidance && <><dt>Hướng dẫn</dt><dd className="guidance-preview">{p.guidance}</dd></>}
              </dl>
            </details>
          </div>
          <div className="project-actions">
            {!p.approved && <button className="button primary small" onClick={() => void onApprove(p.id)}>Duyệt policy</button>}
            <button className="button small" onClick={() => onEdit(p)}>Sửa</button>
            <button className="button ghost small" onClick={() => onContext(p)}>Ngữ cảnh</button>
            <button className="icon-button danger-ghost" onClick={() => onDelete(p)} aria-label={`Xoá dự án ${p.name}`} title="Xoá dự án"><Icon name="trash" size={15}/></button>
          </div>
        </li>;
      })}</ol>}
  </>;
}
