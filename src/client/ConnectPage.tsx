import { useCallback, useEffect, useState } from 'react';
import type { ProjectProfile, Role, RoleConfig } from '../shared/types';
import { api } from './api';
import { Badge, Icon } from './ui';

interface CliStatus { id: 'codex' | 'claude' | 'antigravity'; name: string; installed: boolean; version?: string; command?: string; loggedIn: boolean; billing?: 'subscription' | 'api'; account?: string; models?: string[]; modelOptions?: { id: string; label: string; hint?: string }[]; detail?: string }
interface TestResult { ok: boolean; ms: number; model?: string; reply?: string; error?: string }
type CliId = CliStatus['id'];
const CLI_IDS: CliId[] = ['codex', 'claude', 'antigravity'];
const CLI_NAME: Record<CliId, string> = { codex: 'Codex CLI (OpenAI)', claude: 'Claude Code (Anthropic)', antigravity: 'Antigravity CLI (Google)' };
const MONOGRAM: Record<CliId, string> = { codex: 'CX', claude: 'CL', antigravity: 'AG' };
/** The roles of one project that run on a CLI, for the "in use" line of its card. */
interface Usage { projectId: string; project: string; roles: Role[] }

const GUIDE: Record<CliId, { vendor: string; install: string[]; login: string; plans: string; good: string }> = {
  codex: {
    vendor: 'OpenAI',
    install: ['npm install --prefix .tools/codex @openai/codex'],
    login: 'node .tools/codex/node_modules/@openai/codex/bin/codex.js login',
    plans: 'Dùng tài khoản ChatGPT (Plus/Pro/Team) hoặc API key.',
    good: 'Viết code, lập kế hoạch',
  },
  claude: {
    vendor: 'Anthropic',
    install: ['winget install Anthropic.ClaudeCode', 'npm install -g @anthropic-ai/claude-code'],
    login: 'claude auth login',
    plans: 'Dùng tài khoản Claude (Pro/Max) hoặc Console.',
    good: 'Soát code, viết test nghiệm thu',
  },
  antigravity: {
    vendor: 'Google',
    install: ['irm https://antigravity.google/cli/install.ps1 | iex'],
    login: 'agy',
    plans: 'Chạy lệnh dưới trong PowerShell, đăng nhập Google, rồi gõ /exit.',
    good: 'Lập kế hoạch, soát code (chỉ đọc); viết code, viết test (thử nghiệm)',
  },
};

const ROLES: Role[] = ['planner', 'author', 'developer', 'verifier', 'investigator'];
const ROLE_NAME: Record<Role, string> = { planner: 'Lập kế hoạch', author: 'Viết test', developer: 'Viết code', verifier: 'Soát', investigator: 'Điều tra' };
/** Codex writes the code; Claude writes the acceptance tests and reviews, so checker and author come from another model family. */
export const RECOMMENDED_ROLES: Record<Role, RoleConfig['provider']> = { planner: 'codex', developer: 'codex', author: 'claude', verifier: 'claude', investigator: 'claude' };
const MODELS_SHOWN = 6;

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return <span className="copy-line"><code>{text}</code><button type="button" className="button ghost small" onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}>{done ? 'Đã chép' : 'Chép'}</button></span>;
}

function Step({ n, ok, title, children }: { n: number; ok: boolean; title: string; children: React.ReactNode }) {
  return <li className={`connect-step ${ok ? 'ok' : ''}`}>
    <span className="step-mark" aria-hidden="true">{ok ? <Icon name="check" size={14}/> : n}</span>
    <div className="step-body"><strong>{title}</strong>{children}</div>
  </li>;
}

function CardHead({ id, badge, subtitle }: { id: CliId; badge: React.ReactNode; subtitle?: string }) {
  return <header className="connect-head">
    <span className={`connect-logo logo-${id}`} aria-hidden="true">{MONOGRAM[id]}</span>
    <div><h2>{CLI_NAME[id]}</h2><span className="muted small">{subtitle ?? `${GUIDE[id].vendor} · ${GUIDE[id].good}`}</span></div>
    {badge}
  </header>;
}

/** Placeholder while a CLI is being checked: the layout of the real card, so nothing jumps when it arrives. */
function Skeleton({ id }: { id: CliId }) {
  return <section className="connect-card skeleton-card" aria-busy="true" aria-label={`Đang kiểm tra ${CLI_NAME[id]}`}>
    <CardHead id={id} badge={<Badge tone="neutral">Đang kiểm tra…</Badge>}/>
    <div className="skel-lines" aria-hidden="true"><i className="skel w70"/><i className="skel w45"/><i className="skel w60"/></div>
    <p className="small faint">{id === 'antigravity' ? 'Antigravity mất vài giây để liệt kê model.' : 'Đang chạy lệnh kiểm tra trên máy này…'}</p>
  </section>;
}

function FailedCard({ id, message, onRetry }: { id: CliId; message: string; onRetry: () => void }) {
  return <section className="connect-card">
    <CardHead id={id} subtitle={GUIDE[id].vendor} badge={<Badge tone="bad">Không kiểm tra được</Badge>}/>
    <p className="small bad-text">{message}</p>
    <div className="row-actions"><button type="button" className="button small" onClick={onRetry}><Icon name="refresh" size={14}/>Thử lại</button></div>
  </section>;
}

function CliCard({ status, checking, usage, staleError, onChanged }: { status: CliStatus; checking: boolean; usage: Usage[]; staleError?: string; onChanged: () => Promise<void> }) {
  const g = GUIDE[status.id];
  const [busy, setBusy] = useState<'' | 'install' | 'login' | 'test'>('');
  const [login, setLogin] = useState<{ url?: string; output: string; started: boolean } | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const [installLog, setInstallLog] = useState('');
  const ready = status.installed && status.loggedIn;
  async function act(kind: 'install' | 'login' | 'test') {
    setBusy(kind);
    try {
      if (kind === 'install') { const r = await api<{ ok: boolean; log: string }>('/api/providers/codex/install', 'POST', {}); setInstallLog(r.ok ? 'Đã cài xong.' : r.log); await onChanged(); }
      if (kind === 'login') { const r = await api<{ url?: string; output: string; started: boolean }>(`/api/providers/${status.id}/login`, 'POST', {}); setLogin(r); if (r.url) window.open(r.url, '_blank', 'noopener'); }
      if (kind === 'test') setTest(await api<TestResult>(`/api/providers/${status.id}/test`, 'POST', {}));
    } catch (e) { if (kind === 'test') setTest({ ok: false, ms: 0, error: (e as Error).message }); else setInstallLog((e as Error).message); }
    finally { setBusy(''); }
  }

  const installStep = <Step n={1} ok={status.installed} title="Cài đặt">
    {status.installed ? <span className="muted small">{status.version}</span> : <>
      {status.id === 'codex' && <p className="small">Cài Codex vào thư mục riêng của AI Department (không đụng máy bạn ở chỗ khác):</p>}
      {status.id === 'codex' && <button className="button primary small" disabled={!!busy} onClick={() => void act('install')}>{busy === 'install' ? 'Đang cài (1–3 phút)…' : 'Cài Codex giúp tôi'}</button>}
      <p className="small muted">{status.id === 'codex' ? 'Hoặc tự chạy trong thư mục AI Department:' : status.id === 'antigravity' ? 'Chạy installer chính thức của Google trong PowerShell, rồi bấm Kiểm tra lại:' : 'Chạy một trong hai lệnh sau trong terminal, rồi bấm Kiểm tra lại:'}</p>
      {g.install.map((c) => <Copy key={c} text={c}/>)}
      {installLog && <pre className="detect-pre">{installLog}</pre>}
    </>}
  </Step>;
  const loginStep = <Step n={2} ok={status.loggedIn} title="Đăng nhập">
    {status.loggedIn ? <span className="small">{status.account} · <Badge tone={status.billing === 'subscription' ? 'good' : 'info'}>{status.billing === 'subscription' ? 'Gói thuê bao' : 'API trả theo token'}</Badge></span> : <>
      <p className="small muted">{g.plans}</p>
      {/* agy signs in only from its own terminal UI, so it gets the command and no button. */}
      {status.id !== 'antigravity' && <button className="button primary small" disabled={!status.installed || !!busy} onClick={() => void act('login')}>{busy === 'login' ? 'Đang mở…' : 'Mở trang đăng nhập'}</button>}
      {login && <p className="small">{login.url ? <>Đã mở trang đăng nhập. Nếu trình duyệt không tự mở: <a href={login.url} target="_blank" rel="noopener noreferrer">mở link đăng nhập</a>. Đăng nhập xong bấm <strong>Kiểm tra lại</strong>.</> : login.started ? 'Đã khởi động đăng nhập; làm theo trang vừa mở rồi bấm Kiểm tra lại.' : `Không tự mở được: ${login.output.slice(0, 200)}`}</p>}
      {status.id !== 'antigravity' && <p className="small muted">Hoặc chạy trong terminal:</p>}<Copy text={g.login}/>
    </>}
    <p className="small faint">Token do CLI tự lưu, AI Department không thấy.</p>
  </Step>;
  const testStep = <Step n={3} ok={!!test?.ok} title="Kiểm tra kết nối">
    <p className="small muted">Gửi 1 câu hỏi ngắn, tốn 1 lượt.</p>
    <button className="button small" disabled={!ready || !!busy} onClick={() => void act('test')}>{busy === 'test' ? 'Đang gửi…' : 'Gửi thử 1 lượt'}</button>
    {test && (test.ok ? <p className="small good-text">Trả lời sau {(test.ms / 1000).toFixed(1)} giây{test.model ? ` · model ${test.model}` : ''}{test.reply ? ` · "${test.reply.slice(0, 60)}"` : ''}</p> : <pre className="detect-pre bad-text">{test.error}</pre>)}
  </Step>;

  const models = status.modelOptions ?? [];
  const badge = <Badge tone={checking ? 'neutral' : ready ? 'good' : status.installed ? 'warn' : 'neutral'}>{checking ? 'Đang kiểm tra lại…' : ready ? 'Sẵn sàng' : status.installed ? 'Chưa đăng nhập' : 'Chưa cài'}</Badge>;
  return <section className={`connect-card ${ready ? 'ready' : ''}`} aria-busy={checking}>
    <CardHead id={status.id} badge={badge}/>
    {/* A re-check that failed must not pass silently while the last good answer stays on screen. */}
    {staleError && <p className="notice-line warn" role="alert">Không kiểm tra lại được ({staleError}); đang hiện kết quả của lần kiểm tra trước.</p>}
    {ready ? <>
      {/* Set up already: the facts first, the test next, and install/sign-in tucked away for when they are needed again. */}
      <dl className="connect-facts">
        <dt>Tài khoản</dt><dd>{status.account} <Badge tone={status.billing === 'subscription' ? 'good' : 'info'}>{status.billing === 'subscription' ? 'Gói thuê bao' : 'API trả theo token'}</Badge></dd>
        <dt>Phiên bản</dt><dd className="mono">{status.version}</dd>
        {models.length > 0 && <><dt>Model</dt><dd><span className="model-chips">
          {models.slice(0, MODELS_SHOWN).map((m) => <span key={m.id} className="model-chip" title={m.hint ?? m.id}>{m.label}</span>)}
          {models.length > MODELS_SHOWN && <span className="model-chip more" title={models.slice(MODELS_SHOWN).map((m) => m.label).join(', ')}>+{models.length - MODELS_SHOWN}</span>}
        </span></dd></>}
        <dt>Đang dùng</dt><dd>{usage.length
          ? <ul className="usage-list">{usage.map((u) => <li key={u.projectId}><a href="#/projects">{u.project}</a><span className="muted small">{u.roles.length === ROLES.length ? 'cả 5 vai' : u.roles.map((r) => ROLE_NAME[r]).join(', ')}</span></li>)}</ul>
          : <span className="muted">Chưa có dự án nào giao việc cho AI này.</span>}</dd>
      </dl>
      <div className="connect-test">
        <div><strong>Kiểm tra kết nối</strong><span className="small muted">Gửi 1 câu hỏi ngắn, tốn 1 lượt.</span></div>
        <button className="button small" disabled={!!busy} onClick={() => void act('test')}>{busy === 'test' ? 'Đang gửi…' : 'Gửi thử 1 lượt'}</button>
        {test && (test.ok ? <p className="small good-text">Trả lời sau {(test.ms / 1000).toFixed(1)} giây{test.model ? ` · model ${test.model}` : ''}{test.reply ? ` · "${test.reply.slice(0, 60)}"` : ''}</p> : <pre className="detect-pre bad-text">{test.error}</pre>)}
      </div>
      <details className="connect-details"><summary>Cài đặt và đăng nhập</summary><ol className="connect-steps">{installStep}{loginStep}</ol></details>
    </> : <ol className="connect-steps">{installStep}{loginStep}{testStep}</ol>}
    {status.billing === 'subscription' && status.id === 'claude' && <p className="notice-line">Gói thuê bao không trừ vào ngân sách task; hạn mức của gói vẫn áp dụng.</p>}
    {status.id === 'antigravity' && <p className="notice-line">Không chạy lệnh nào. Lập kế hoạch, Soát, Điều tra: không sửa file. Viết code, viết test (thử nghiệm): chỉ sửa file trong bản sao làm việc.</p>}
  </section>;
}

/** Connect the agent CLIs and choose who does what: install, sign in, test, and apply a role split to a project. */
export function ConnectPage({ projects, onProjectsChanged }: { projects: ProjectProfile[]; onProjectsChanged: () => Promise<void> }) {
  const [statuses, setStatuses] = useState<Partial<Record<CliId, CliStatus>>>({});
  const [checking, setChecking] = useState<Record<CliId, boolean>>({ codex: true, claude: true, antigravity: true });
  const [errors, setErrors] = useState<Partial<Record<CliId, string>>>({});
  const [target, setTarget] = useState('');
  const [applied, setApplied] = useState('');
  /** Each CLI is asked on its own, so a slow one (Antigravity lists its models for a few seconds) never holds up the others. */
  const loadOne = useCallback(async (id: CliId, refresh = false) => {
    setChecking((c) => ({ ...c, [id]: true }));
    try {
      const status = await api<CliStatus>(`/api/providers/${id}${refresh ? '?refresh=1' : ''}`);
      setStatuses((p) => ({ ...p, [id]: status }));
      setErrors((e) => { const { [id]: _gone, ...rest } = e; return rest; });
    } catch (e) { setErrors((p) => ({ ...p, [id]: (e as Error).message })); }
    finally { setChecking((c) => ({ ...c, [id]: false })); }
  }, []);
  const loadAll = useCallback((refresh = false) => Promise.all(CLI_IDS.map((id) => loadOne(id, refresh))).then(() => undefined), [loadOne]);
  useEffect(() => { void loadAll(); }, [loadAll]);

  const ready = (id: CliId) => !!statuses[id]?.installed && !!statuses[id]?.loggedIn;
  const readyCount = CLI_IDS.filter(ready).length;
  const both = ready('codex') && ready('claude');
  const anyChecking = CLI_IDS.some((id) => checking[id]);
  const settled = CLI_IDS.every((id) => statuses[id] || errors[id]);
  const usageOf = (provider: CliId): Usage[] => projects.flatMap((p) => {
    const roles = ROLES.filter((r) => p.roles[r]?.provider === provider);
    return roles.length ? [{ projectId: p.id, project: p.name, roles }] : [];
  });
  async function apply() {
    const p = projects.find((x) => x.id === target);
    if (!p) return;
    const roles = Object.fromEntries(ROLES.map((r) => [r, { ...p.roles[r], provider: RECOMMENDED_ROLES[r] }])) as Record<Role, RoleConfig>;
    try { await api(`/api/projects/${p.id}`, 'PATCH', { roles }); setApplied(`Đã đặt vai cho "${p.name}". Vào Dự án và bấm Duyệt policy để áp dụng.`); await onProjectsChanged(); } catch (e) { setApplied((e as Error).message); }
  }
  return <>
    <header className="page-header"><div><h1>Kết nối AI</h1>
      <p>{settled ? (readyCount ? `${readyCount}/3 AI sẵn sàng để AI Department giao việc.` : 'Chưa có AI nào sẵn sàng. Làm theo các bước trong từng thẻ.') : 'Kết nối các AI để AI Department giao việc cho chúng.'}</p></div>
      <button className="button" disabled={anyChecking} onClick={() => void loadAll(true)}><Icon name="refresh" size={14}/>{anyChecking ? 'Đang kiểm tra…' : 'Kiểm tra lại'}</button></header>
    <div className="connect-grid">{CLI_IDS.map((id) => {
      const status = statuses[id];
      if (status) return <CliCard key={id} status={status} checking={checking[id]} usage={usageOf(id)} staleError={errors[id]} onChanged={() => loadOne(id, true)}/>;
      if (errors[id]) return <FailedCard key={id} id={id} message={errors[id]!} onRetry={() => void loadOne(id, true)}/>;
      return <Skeleton key={id} id={id}/>;
    })}</div>
    {settled && <section className="panel-card connect-roles">
      <div className="card-head"><h3>Cách chia việc gợi ý</h3>{both ? <Badge tone="good">Codex và Claude sẵn sàng</Badge> : <Badge tone="neutral">Cần cả Codex và Claude</Badge>}</div>
      <div className="role-split">{ROLES.filter((r) => r !== 'investigator').map((r) => <div key={r} className={`role-pill provider-${RECOMMENDED_ROLES[r]}`}><strong>{ROLE_NAME[r]}</strong><span>{RECOMMENDED_ROLES[r] === 'codex' ? 'Codex' : 'Claude'}</span></div>)}</div>
      <p className="small muted">Người soát khác hãng với người viết code nên dễ bắt lỗi hơn. Chỉnh từng vai trong Sửa dự án.</p>
      <div className="row-actions">
        <select aria-label="Chọn dự án" value={target} onChange={(e) => setTarget(e.target.value)}><option value="">Chọn dự án…</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <button className="button primary small" disabled={!target || !both} onClick={() => void apply()}>Áp dụng cách chia này</button>
      </div>
      {applied && <p className="notice-line">{applied}</p>}
      {ready('antigravity') && <p className="small muted">Antigravity có thể nhận Lập kế hoạch hoặc Soát, hoặc thử nghiệm viết code và test, trong <strong>Sửa dự án</strong>.</p>}
    </section>}
  </>;
}
