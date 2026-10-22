import { useCallback, useEffect, useState } from 'react';
import type { ProjectProfile, Role, RoleConfig } from '../shared/types';
import { api } from './api';
import { Badge, Icon } from './ui';

interface CliStatus { id: 'codex' | 'claude' | 'antigravity'; name: string; installed: boolean; version?: string; command?: string; loggedIn: boolean; billing?: 'subscription' | 'api'; account?: string; models?: string[]; detail?: string }
interface TestResult { ok: boolean; ms: number; model?: string; reply?: string; error?: string }

const GUIDE: Record<CliStatus['id'], { vendor: string; install: string[]; login: string; plans: string; good: string }> = {
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
/** Codex writes the code; Claude writes the acceptance tests and reviews, so checker and author come from another model family. */
export const RECOMMENDED_ROLES: Record<Role, RoleConfig['provider']> = { planner: 'codex', developer: 'codex', author: 'claude', verifier: 'claude', investigator: 'claude' };

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

function CliCard({ status, onChanged }: { status: CliStatus; onChanged: () => Promise<void> }) {
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
  return <section className={`connect-card ${ready ? 'ready' : ''}`}>
    <header className="connect-head">
      <span className={`connect-logo logo-${status.id}`} aria-hidden="true">{{ codex: 'CX', claude: 'CL', antigravity: 'AG' }[status.id]}</span>
      <div><h2>{status.name}</h2><span className="muted small">{g.vendor} · {g.good}</span></div>
      <Badge tone={ready ? 'good' : status.installed ? 'warn' : 'neutral'}>{ready ? 'Sẵn sàng' : status.installed ? 'Chưa đăng nhập' : 'Chưa cài'}</Badge>
    </header>
    <ol className="connect-steps">
      <Step n={1} ok={status.installed} title="Cài đặt">
        {status.installed ? <span className="muted small">{status.version}</span> : <>
          {status.id === 'codex' && <p className="small">Cài Codex vào thư mục riêng của AI Department (không đụng máy bạn ở chỗ khác):</p>}
          {status.id === 'codex' && <button className="button primary small" disabled={!!busy} onClick={() => void act('install')}>{busy === 'install' ? 'Đang cài (1–3 phút)…' : 'Cài Codex giúp tôi'}</button>}
          <p className="small muted">{status.id === 'codex' ? 'Hoặc tự chạy trong thư mục AI Department:' : status.id === 'antigravity' ? 'Chạy installer chính thức của Google trong PowerShell, rồi bấm Kiểm tra lại:' : 'Chạy một trong hai lệnh sau trong terminal, rồi bấm Kiểm tra lại:'}</p>
          {g.install.map((c) => <Copy key={c} text={c}/>)}
          {installLog && <pre className="detect-pre">{installLog}</pre>}
        </>}
      </Step>
      <Step n={2} ok={status.loggedIn} title="Đăng nhập">
        {status.loggedIn ? <span className="small">{status.account} · <Badge tone={status.billing === 'subscription' ? 'good' : 'info'}>{status.billing === 'subscription' ? 'Gói thuê bao' : 'API trả theo token'}</Badge></span> : <>
          <p className="small muted">{g.plans}</p>
          {/* agy signs in only from its own terminal UI, so it gets the command and no button. */}
          {status.id !== 'antigravity' && <button className="button primary small" disabled={!status.installed || !!busy} onClick={() => void act('login')}>{busy === 'login' ? 'Đang mở…' : 'Mở trang đăng nhập'}</button>}
          {login && <p className="small">{login.url ? <>Đã mở trang đăng nhập. Nếu trình duyệt không tự mở: <a href={login.url} target="_blank" rel="noopener noreferrer">mở link đăng nhập</a>. Đăng nhập xong bấm <strong>Kiểm tra lại</strong>.</> : login.started ? 'Đã khởi động đăng nhập; làm theo trang vừa mở rồi bấm Kiểm tra lại.' : `Không tự mở được: ${login.output.slice(0, 200)}`}</p>}
          {status.id !== 'antigravity' && <p className="small muted">Hoặc chạy trong terminal:</p>}<Copy text={g.login}/>
        </>}
        <p className="small faint">Token do CLI tự lưu, AI Department không thấy.</p>
      </Step>
      <Step n={3} ok={!!test?.ok} title="Kiểm tra kết nối">
        <p className="small muted">Gửi 1 câu hỏi ngắn, tốn 1 lượt.</p>
        <button className="button small" disabled={!ready || !!busy} onClick={() => void act('test')}>{busy === 'test' ? 'Đang gửi…' : 'Gửi thử 1 lượt'}</button>
        {test && (test.ok ? <p className="small good-text">Trả lời sau {(test.ms / 1000).toFixed(1)} giây{test.model ? ` · model ${test.model}` : ''}{test.reply ? ` · "${test.reply.slice(0, 60)}"` : ''}</p> : <pre className="detect-pre bad-text">{test.error}</pre>)}
      </Step>
    </ol>
    {status.billing === 'subscription' && status.id === 'claude' && <p className="notice-line">Gói thuê bao không trừ vào ngân sách task; hạn mức của gói vẫn áp dụng.</p>}
    {status.id === 'antigravity' && <p className="notice-line">Không chạy lệnh nào. Lập kế hoạch, Soát, Điều tra: không sửa file. Viết code, viết test (thử nghiệm): chỉ sửa file trong bản sao làm việc.</p>}
  </section>;
}

/** Connect the agent CLIs and choose who does what: install, sign in, test, and apply a role split to a project. */
const ROLE_NAME: Record<Role, string> = { planner: 'Lập kế hoạch', author: 'Viết test', developer: 'Viết code', verifier: 'Soát', investigator: 'Điều tra' };

export function ConnectPage({ projects, onProjectsChanged }: { projects: ProjectProfile[]; onProjectsChanged: () => Promise<void> }) {
  const [statuses, setStatuses] = useState<CliStatus[] | null>(null);
  const [error, setError] = useState('');
  const [target, setTarget] = useState('');
  const [applied, setApplied] = useState('');
  const load = useCallback(async (refresh = false) => { try { setStatuses(await api<CliStatus[]>(`/api/providers${refresh ? '?refresh=1' : ''}`)); setError(''); } catch (e) { setError((e as Error).message); } }, []);
  useEffect(() => { void load(); }, [load]);
  const ready = (id: CliStatus['id']) => !!statuses?.find((s) => s.id === id && s.installed && s.loggedIn);
  const both = ready('codex') && ready('claude');
  const usage = (provider: string) => projects.filter((p) => ROLES.some((r) => p.roles[r]?.provider === provider));
  async function apply() {
    const p = projects.find((x) => x.id === target);
    if (!p) return;
    const roles = Object.fromEntries(ROLES.map((r) => [r, { ...p.roles[r], provider: RECOMMENDED_ROLES[r] }])) as Record<Role, RoleConfig>;
    try { await api(`/api/projects/${p.id}`, 'PATCH', { roles }); setApplied(`Đã đặt vai cho "${p.name}". Vào Projects và bấm Duyệt policy để áp dụng.`); await onProjectsChanged(); } catch (e) { setApplied((e as Error).message); }
  }
  return <>
    <header className="page-header"><div><h1>Kết nối AI</h1><p>Kết nối các AI để AI Department giao việc cho chúng.</p></div>
      <button className="button" onClick={() => void load(true)}><Icon name="refresh" size={14}/>Kiểm tra lại</button></header>
    {error && <div className="banner error" role="alert">{error}</div>}
    {!statuses ? <p className="muted">Đang kiểm tra các AI trên máy này…</p> : <div className="connect-grid">{statuses.map((s) => <CliCard key={s.id} status={s} onChanged={() => load(true)}/>)}</div>}
    {statuses && <section className="panel-card connect-roles">
      <div className="card-head"><h3>Cách chia việc gợi ý</h3>{both ? <Badge tone="good">Codex và Claude sẵn sàng</Badge> : <Badge tone="neutral">Cần cả Codex và Claude</Badge>}</div>
      <div className="role-split">{ROLES.filter((r) => r !== 'investigator').map((r) => <div key={r} className={`role-pill provider-${RECOMMENDED_ROLES[r]}`}><strong>{ROLE_NAME[r]}</strong><span>{RECOMMENDED_ROLES[r] === 'codex' ? 'Codex' : 'Claude'}</span></div>)}</div>
      <p className="small muted">Người soát khác hãng với người viết code nên dễ bắt lỗi hơn. Chỉnh từng vai trong Sửa dự án.</p>
      <div className="row-actions">
        <select aria-label="Chọn dự án" value={target} onChange={(e) => setTarget(e.target.value)}><option value="">Chọn dự án…</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <button className="button primary small" disabled={!target || !both} onClick={() => void apply()}>Áp dụng cách chia này</button>
      </div>
      {applied && <p className="notice-line">{applied}</p>}
      {ready('antigravity') && <p className="small muted">Antigravity có thể nhận Lập kế hoạch hoặc Soát, hoặc thử nghiệm viết code và test, trong <strong>Sửa dự án</strong>.</p>}
      <p className="small faint">Đang dùng: Codex {usage('codex').length} dự án · Claude {usage('claude').length} · Antigravity {usage('antigravity').length}</p>
    </section>}
  </>;
}
