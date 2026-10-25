import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { ProjectProfile, Role, RoleConfig, StackDetection } from '../shared/types';
import { api } from './api';
import { folderName, formatCommandLine, parseCommandLine } from './argv';
import { CHECK_PRESETS, draftArgv, draftFromSuggestion, toDrafts, toRecipes, type CheckDraft } from './checkdraft';
import { ALL_MODULES, ChecksEditor, DetectPanel, GuidanceField, ROLE_PRESETS, RolesEditor, cliOk, defaultPreset, presetOf, rolesFor, useCliReady, type CliReady } from './projectfields';
import { Field, Icon, Modal } from './ui';

/*
 * The new-project and edit-project forms share one layout: the folder, name and budget, then who works, the
 * acceptance checks, where the AI may edit, and the technical options folded under "Nâng cao".
 */

const ROLES: Role[] = ['planner', 'author', 'developer', 'verifier', 'investigator'];
const blankRoles = () => Object.fromEntries(ROLES.map((role) => [role, { provider: 'codex', model: '', effort: 'medium', skills: [] }])) as unknown as Record<Role, RoleConfig>;
const commandText = (d: CheckDraft) => { const argv = draftArgv(d); return argv ? formatCommandLine(argv) : d.command; };
/** A command field's value as argv, with the field named in the error. */
const commandOf = (label: string, text: string): string[] => {
  try { return parseCommandLine(text); } catch (e) { throw new Error(`${label}: ${(e as Error).message}`); }
};
type Scope = 'some' | 'all';
const scopeOf = (modules: readonly string[]): Scope => (modules.length === 1 && modules[0] === ALL_MODULES ? 'all' : 'some');
const modulesOf = (scope: Scope, text: string): string[] => {
  if (scope === 'all') return [ALL_MODULES];
  const list = text.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
  if (!list.length) throw new Error('Ghi ít nhất một thư mục AI được sửa, hoặc chọn Toàn bộ repo.');
  return list;
};

// ---------------------------------------------------------------- folder picker

interface FolderListing { path: string; parent: string | null; truncated: boolean; folders: { name: string; path: string; git: boolean; node: boolean }[]; places: { label: string; path: string }[] }

/** Browses this machine's folders through the server (a web page cannot read full paths) and returns the one chosen. */
export function FolderPicker({ start, onPick, onClose }: { start: string; onPick: (path: string) => void; onClose: () => void }) {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function open(path?: string, fallbackHome = false) {
    setBusy(true); setError('');
    try {
      const next = await api<FolderListing>(`/api/system/folders${path ? `?path=${encodeURIComponent(path)}` : ''}`);
      setListing(next); setTyped(next.path);
    } catch (e) {
      if (fallbackHome) return open();
      setError((e as Error).message);
    } finally { setBusy(false); }
  }
  // Start where the field points, or at the home folder when that path does not exist.
  useEffect(() => { void open(start.trim() || undefined, true); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <Modal title="Chọn thư mục" size="md" onClose={onClose}>
    <div className="folder-picker">
      <div className="fp-bar">
        <button type="button" className="icon-button" disabled={!listing?.parent || busy} onClick={() => void open(listing!.parent!)} aria-label="Lên một cấp" title="Lên một cấp"><Icon name="back" size={16}/></button>
        <input className="mono" aria-label="Đường dẫn" value={typed} spellCheck={false} onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void open(typed); } }}/>
      </div>
      <div className="fp-body">
        <nav className="fp-places" aria-label="Lối tắt">{listing?.places.map((p) => <button type="button" key={p.path} className={listing.path === p.path ? 'active' : ''} onClick={() => void open(p.path)} title={p.path}>
          <Icon name="folder" size={14}/><span>{p.label}</span></button>)}</nav>
        <ul className="fp-list" aria-busy={busy}>{!listing ? <li className="fp-empty">{busy ? 'Đang đọc…' : ''}</li>
          : !listing.folders.length ? <li className="fp-empty">Không có thư mục con. Bấm "Chọn thư mục này" để dùng thư mục hiện tại.</li>
          : listing.folders.map((f) => <li key={f.path}>
            <button type="button" className="fp-open" onClick={() => void open(f.path)} title={f.path}>
              <Icon name="folder" size={15}/><span className="fp-name">{f.name}</span>
              {f.git && <span className="fp-tag">git</span>}{f.node && <span className="fp-tag">Node</span>}<Icon name="chevron" size={13}/></button>
            <button type="button" className="fp-pick" onClick={() => onPick(f.path)}>Chọn</button>
          </li>)}
          {listing?.truncated && <li className="fp-empty">Chỉ hiện 500 thư mục đầu tiên; gõ đường dẫn để đi thẳng tới thư mục cần.</li>}
        </ul>
      </div>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="modal-footer"><span className="fp-current mono" title={listing?.path}>{listing?.path}</span>
        <button type="button" className="button" onClick={onClose}>Huỷ</button>
        <button type="button" className="button primary" disabled={!listing || busy} onClick={() => listing && onPick(listing.path)}>Chọn thư mục này</button></div>
    </div>
  </Modal>;
}

// ---------------------------------------------------------------- shared sections

function RolesSection({ value, onChange, ready, startCustom = false, onConnect }: { value: Record<Role, RoleConfig>; onChange: (next: Record<Role, RoleConfig>) => void; ready: CliReady[] | null; startCustom?: boolean; onConnect: () => void }) {
  const [custom, setCustom] = useState(startCustom);
  const preset = presetOf(value);
  const missing = (needs: readonly string[]) => (ready ? needs.filter((id) => !cliOk(ready, id)) : []);
  const current = ROLE_PRESETS.find((p) => p.id === preset);
  return <section className="pf-section">
    <div className="pf-head"><span className="pf-label">Ai làm việc</span>
      <button type="button" className="text-button" onClick={() => setCustom((v) => !v)}>{custom ? 'Thu gọn' : 'Tuỳ chỉnh từng vai'}</button></div>
    <div className="choice-grid" role="radiogroup" aria-label="Ai làm việc">{ROLE_PRESETS.map((p) => {
      const gaps = missing(p.needs);
      return <button key={p.id} type="button" role="radio" aria-checked={preset === p.id} className={`choice${preset === p.id ? ' selected' : ''}`} onClick={() => onChange(rolesFor(p.id, value))}>
        <span className="choice-title">{p.label}{p.id === 'split' && <span className="badge badge-blue">Gợi ý</span>}</span>
        <span className="choice-desc">{p.desc}</span>
        {gaps.length > 0 && <span className="choice-warn">{gaps.map((g) => (g === 'codex' ? 'Codex' : 'Claude')).join(', ')} chưa kết nối</span>}
      </button>;
    })}</div>
    {preset === null && !custom && <p className="pf-hint">Đang dùng cách chia tuỳ chỉnh. Bấm "Tuỳ chỉnh từng vai" để xem.</p>}
    {custom && <RolesEditor presets={false} value={value} onChange={onChange}/>}
    {!custom && current && missing(current.needs).length > 0 && <p className="notice-line warn">Cách chia này cần AI chưa kết nối trên máy. <a href="#/connect" onClick={onConnect}>Mở Kết nối AI</a></p>}
  </section>;
}

function ChecksSection({ drafts, onChange, action, children }: { drafts: CheckDraft[]; onChange: (next: CheckDraft[]) => void; action?: ReactNode; children?: ReactNode }) {
  const [editing, setEditing] = useState(false);
  return <section className="pf-section">
    <div className="pf-head"><span className="pf-label">Check nghiệm thu <span className="count-chip">{drafts.length}</span></span>
      <span className="pf-actions">{action}<button type="button" className="text-button" onClick={() => setEditing((v) => !v)}>{editing ? 'Xong' : 'Sửa'}</button></span></div>
    {editing ? <ChecksEditor drafts={drafts} onChange={onChange}/>
      : <ul className="pf-checks">{drafts.map((d) => <li key={d.key}>
        <span className="pf-check-id">{d.id}</span><code title={commandText(d)}>{commandText(d)}</code>
        <span className="pf-check-tags">{d.required ? 'Bắt buộc' : 'Tuỳ chọn'}{d.reportPath ? ' · có report' : ''}</span>
      </li>)}</ul>}
    {children}
    <p className="pf-hint">Việc chỉ nghiệm thu được khi các check bắt buộc pass.</p>
  </section>;
}

function ScopeSection({ scope, onScope, modules, onModules }: { scope: Scope; onScope: (s: Scope) => void; modules: string; onModules: (text: string) => void }) {
  return <section className="pf-section">
    <span className="pf-label">AI được sửa ở đâu</span>
    <div className="segmented" role="group" aria-label="Phạm vi được sửa">
      <button type="button" className={scope === 'some' ? 'active' : ''} aria-pressed={scope === 'some'} onClick={() => onScope('some')}>Một số thư mục</button>
      <button type="button" className={scope === 'all' ? 'active' : ''} aria-pressed={scope === 'all'} onClick={() => onScope('all')}>Toàn bộ repo</button>
    </div>
    {scope === 'some' && <input className="mono" aria-label="Thư mục AI được sửa" value={modules} onChange={(e) => onModules(e.target.value)} placeholder="src, tests" spellCheck={false}/>}
    <p className="pf-hint">{scope === 'some' ? 'Ngăn cách bằng dấu phẩy. Sửa ngoài các thư mục này phải chờ bạn duyệt.' : 'Lockfile, package.json, tsconfig, cấu hình test và test đã khoá vẫn được bảo vệ. File như .env thì không.'}</p>
  </section>;
}

function AdvancedSection({ guidance, onGuidance, executionMode, onMode, setup, onSetup, allowScaffold, onScaffold, children }: {
  guidance: string; onGuidance: (t: string) => void; executionMode: 'local' | 'docker'; onMode: (m: 'local' | 'docker') => void;
  setup: string; onSetup: (t: string) => void; allowScaffold: boolean; onScaffold: (v: boolean) => void; children?: ReactNode;
}) {
  return <details className="pf-advanced">
    <summary><span>Nâng cao</span><small>Hướng dẫn cho AI, nơi chạy, lệnh cài đặt</small></summary>
    <GuidanceField value={guidance} onChange={onGuidance}/>
    <div className="field"><span>Nơi chạy</span>
      <div className="segmented" role="group" aria-label="Nơi chạy">
        <button type="button" className={executionMode === 'local' ? 'active' : ''} aria-pressed={executionMode === 'local'} onClick={() => onMode('local')}>Trên máy này</button>
        <button type="button" className={executionMode === 'docker' ? 'active' : ''} aria-pressed={executionMode === 'docker'} onClick={() => onMode('docker')}>Docker</button>
      </div>
      <small>{executionMode === 'local' ? 'AI làm trên một bản sao trong .data/workspaces, không có cô lập container.' : 'AI chạy trong container khoá; cần attestation của operator, và Codex hiện chưa chạy lệnh được trong container.'}</small></div>
    {executionMode === 'local' && <Field label="Lệnh cài đặt" hint="Chạy một lần khi tạo bản sao làm việc. Để trống nếu không cần.">
      <input className="mono" value={setup} onChange={(e) => onSetup(e.target.value)} placeholder="npm ci" spellCheck={false}/></Field>}
    {children}
    <label className="inline-check pf-scaffold"><input type="checkbox" checked={allowScaffold} onChange={(e) => onScaffold(e.target.checked)}/>Cho phép AI tạo file thiết lập còn thiếu</label>
    <p className="pf-hint">Dành cho dự án mới cần dựng stack: AI được tạo package.json, tsconfig, cấu hình test khi chúng chưa có. File đã có vẫn bị khoá.</p>
  </details>;
}

function NameBudget({ name, onName, budget, onBudget, placeholder }: { name: string; onName: (t: string) => void; budget: number; onBudget: (n: number) => void; placeholder?: string }) {
  return <div className="pf-row">
    <Field label="Tên dự án"><input required value={name} onChange={(e) => onName(e.target.value)} placeholder={placeholder}/></Field>
    <Field label="Ngân sách mỗi việc"><span className="input-affix"><span aria-hidden="true">$</span><input type="number" required min="0.1" step="0.1" value={budget} onChange={(e) => onBudget(Number(e.target.value))} aria-label="Ngân sách mỗi việc (USD)"/></span></Field>
  </div>;
}

// ---------------------------------------------------------------- new project

type Detection = { path: string; busy?: boolean; result?: StackDetection; error?: string };

/**
 * New project in one screen, like importing a repository: pick the folder, the stack detector (read only) fills in
 * the name, checks, install command and guidance, and the person adjusts what matters.
 */
export function ProjectForm({ onClose, onSave, busy }: { onClose: () => void; onSave: (body: unknown) => Promise<void>; busy: boolean }) {
  const ready = useCliReady();
  const [repository, setRepository] = useState('');
  const [picking, setPicking] = useState(false);
  const [name, setName] = useState('');
  const [budget, setBudget] = useState(5);
  const [roleConfig, setRoleConfig] = useState<Record<Role, RoleConfig>>(() => rolesFor('split', blankRoles()));
  const [rolesTouched, setRolesTouched] = useState(false);
  const [drafts, setDrafts] = useState<CheckDraft[]>(() => toDrafts([{ id: 'test', command: CHECK_PRESETS[0]!.command, required: true, timeoutMs: 600000, reportPath: CHECK_PRESETS[0]!.reportPath }]));
  const [scope, setScope] = useState<Scope>('some');
  const [modules, setModules] = useState('src, tests');
  const [guidance, setGuidance] = useState('');
  const [executionMode, setExecutionMode] = useState<'local' | 'docker'>('local');
  const [setup, setSetup] = useState('npm ci');
  const [image, setImage] = useState('node:24-bookworm-slim');
  const [mutationRoot, setMutationRoot] = useState('');
  const [allowScaffold, setAllowScaffold] = useState(false);
  const [detection, setDetection] = useState<Detection | null>(null);
  const [error, setError] = useState('');
  // What the person typed wins over what detection suggests.
  const [touched, setTouched] = useState({ name: false, checks: false, setup: false });
  const touch = (key: keyof typeof touched) => setTouched((t) => (t[key] ? t : { ...t, [key]: true }));

  // Once we know which CLIs are signed in, start from the split they can actually run.
  useEffect(() => { if (ready && !rolesTouched) setRoleConfig((cur) => rolesFor(defaultPreset(ready), cur)); }, [ready, rolesTouched]);

  const setFolder = (value: string) => { setRepository(value); if (!touched.name) setName(folderName(value)); };
  async function detect(path = repository, again = false) {
    const target = path.trim();
    if (!target || (!again && detection?.path === target && !detection.error)) return;
    setDetection({ path: target, busy: true });
    try {
      const found = await api<StackDetection>('/api/projects/detect', 'POST', { repository: target });
      setDetection({ path: target, result: found });
      const recommended = found.checks.filter((c) => c.recommended);
      if (!touched.checks && recommended.length) setDrafts(recommended.reduce<CheckDraft[]>((acc, s) => [...acc, draftFromSuggestion(s, acc)], []));
      if (!touched.setup) setSetup(formatCommandLine(found.setupCommand));
      if (!guidance.trim() && found.guidance) setGuidance(found.guidance);
    } catch (e) { setDetection({ path: target, error: (e as Error).message }); }
  }
  const current = detection?.path === repository.trim() ? detection : null;
  const found = current?.result;
  const filled = found ? [found.checks.some((c) => c.recommended) && !touched.checks ? `${drafts.length} check` : '', found.setupCommand.length && !touched.setup ? 'lệnh cài đặt' : '', found.guidance && guidance === found.guidance ? 'hướng dẫn cho AI' : ''].filter(Boolean) : [];

  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    try {
      const checks = toRecipes(drafts);
      const setupCommand = commandOf('Lệnh cài đặt', setup);
      await onSave({ name: name.trim() || folderName(repository), repository: repository.trim(), modules: modulesOf(scope, modules), checks, guidance, ...(mutationRoot.trim() ? { mutationRoot: mutationRoot.trim() } : {}), allowScaffold, singleBudgetUsd: budget, roles: roleConfig, runnerImage: image, executionMode, ...(executionMode === 'local' ? { setupCommand } : {}) });
    } catch (e) { setError((e as Error).message); }
  }

  return <Modal title="Thêm dự án" subtitle="Chọn thư mục code. AI Department tự nhận diện stack và điền sẵn phần còn lại." onClose={onClose}><>
    <form className="project-form" onSubmit={submit}>
      <section className="pf-section">
        <label className="pf-label" htmlFor="pf-folder">Thư mục code</label>
        <div className="pf-folder">
          <input id="pf-folder" className="mono" required value={repository} placeholder="C:\projects\my-app" spellCheck={false} autoFocus
            onChange={(e) => setFolder(e.target.value)} onBlur={() => void detect()} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void detect(); } }}/>
          <button type="button" className="button" onClick={() => setPicking(true)}><Icon name="folder" size={14}/>Chọn thư mục</button>
        </div>
        {current?.busy ? <p className="pf-hint">Đang đọc thư mục…</p>
          : current?.error ? <p className="inline-error" role="alert">{current.error}</p>
          : found ? <div className="pf-detected">
            <span className="pf-detected-ok"><Icon name="check" size={14}/>Đã nhận diện</span>
            {[...found.languages, ...found.frameworks, ...(found.testRunner ? [found.testRunner] : []), ...(found.packageManager ? [found.packageManager] : [])].map((c) => <span className="chip" key={c}>{c}</span>)}
            {filled.length > 0 && <span className="pf-filled">Đã điền sẵn {filled.join(', ')}.</span>}
            {found.notes.map((n) => <p className="notice-line" key={n}>{n}</p>)}
            <button type="button" className="text-button pf-redetect" onClick={() => void detect(repository, true)}>Nhận diện lại</button>
          </div>
          : <p className="pf-hint">Git không bắt buộc. Code trong thư mục chỉ thay đổi khi bạn nghiệm thu.</p>}
      </section>
      <NameBudget name={name} onName={(t) => { setName(t); touch('name'); }} budget={budget} onBudget={setBudget} placeholder="my-app"/>
      <RolesSection value={roleConfig} onChange={(next) => { setRoleConfig(next); setRolesTouched(true); }} ready={ready} onConnect={onClose}/>
      <ChecksSection drafts={drafts} onChange={(next) => { setDrafts(next); touch('checks'); }}/>
      <ScopeSection scope={scope} onScope={setScope} modules={modules} onModules={setModules}/>
      <AdvancedSection guidance={guidance} onGuidance={setGuidance} executionMode={executionMode} onMode={setExecutionMode} setup={setup} onSetup={(t) => { setSetup(t); touch('setup'); }} allowScaffold={allowScaffold} onScaffold={setAllowScaffold}>
      <Field label="Thư mục mutation" hint="Để trống để tự nhận diện; monorepo dùng đường dẫn package tương đối, ví dụ packages/api. Dấu . là gốc repo."><input value={mutationRoot} onChange={e => setMutationRoot(e.target.value)}/></Field>
        {executionMode === 'docker' && <Field label="Runner image"><input className="mono" value={image} onChange={(e) => setImage(e.target.value)} required spellCheck={false}/></Field>}
      </AdvancedSection>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="modal-footer"><span className="pf-foot">Dự án mới cần duyệt policy trước khi chạy thật.</span>
        <button type="button" className="button" onClick={onClose}>Huỷ</button><button className="button primary" disabled={busy}>{busy ? 'Đang tạo…' : 'Tạo dự án'}</button></div>
    </form>
    {picking && <FolderPicker start={repository} onClose={() => setPicking(false)} onPick={(path) => { setPicking(false); setFolder(path); void detect(path, true); }}/>}
  </></Modal>;
}

// ---------------------------------------------------------------- edit project

/**
 * Same layout as the new-project form. The folder cannot change; stack detection is offered on demand and never
 * overwrites the saved checks by itself. Any change raises the policy version and needs approval again.
 */
export function ProjectEditForm({ project, onClose, onSave, busy }: { project: ProjectProfile; onClose: () => void; onSave: (body: unknown) => Promise<void>; busy: boolean }) {
  const ready = useCliReady();
  const [name, setName] = useState(project.name);
  const [budget, setBudget] = useState(project.singleBudgetUsd);
  const [roleConfig, setRoleConfig] = useState<Record<Role, RoleConfig>>(() => structuredClone(project.roles));
  const [drafts, setDrafts] = useState<CheckDraft[]>(() => toDrafts(project.checks));
  const [suggest, setSuggest] = useState(false);
  const [scope, setScope] = useState<Scope>(scopeOf(project.modules));
  const [modules, setModules] = useState(scopeOf(project.modules) === 'all' ? 'src, tests' : project.modules.join(', '));
  const [guidance, setGuidance] = useState(project.guidance ?? '');
  const [executionMode, setExecutionMode] = useState<'local' | 'docker'>(project.executionMode ?? 'docker');
  const [setup, setSetup] = useState(formatCommandLine(project.setupCommand));
  const [preview, setPreview] = useState(formatCommandLine(project.previewCommand ?? []));
  const [mutationRoot, setMutationRoot] = useState(project.mutationRoot ?? '');
  const [allowScaffold, setAllowScaffold] = useState(!!project.allowScaffold);
  const [error, setError] = useState('');
  // Models or effort set per role only show in the full table, so open it when the project uses them.
  const tuned = presetOf(project.roles) === null || ROLES.some((r) => project.roles[r].model || project.roles[r].effort !== 'medium');

  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    try {
      const checks = toRecipes(drafts);
      await onSave({ name: name.trim(), modules: modulesOf(scope, modules), checks, setupCommand: commandOf('Lệnh cài đặt', setup), guidance, mutationRoot: mutationRoot.trim(), executionMode, previewCommand: commandOf('Lệnh chạy thử', preview), allowScaffold, roles: roleConfig, singleBudgetUsd: budget });
    } catch (e) { setError((e as Error).message); }
  }

  return <Modal title={`Sửa dự án · ${project.name}`} subtitle="Việc đang có giữ cấu hình cũ cho tới khi bạn bấm Chạy lại check." onClose={onClose}>
    <form className="project-form" onSubmit={submit}>
      <section className="pf-section">
        <span className="pf-label">Thư mục code</span>
        <div className="pf-folder-static" title={project.repository}><Icon name="folder" size={15}/><span className="mono">{project.repository}</span></div>
      </section>
      <NameBudget name={name} onName={setName} budget={budget} onBudget={setBudget}/>
      <RolesSection value={roleConfig} onChange={setRoleConfig} ready={ready} startCustom={tuned} onConnect={onClose}/>
      <ChecksSection drafts={drafts} onChange={setDrafts} action={<button type="button" className="text-button" onClick={() => setSuggest((v) => !v)}>{suggest ? 'Ẩn gợi ý' : 'Gợi ý từ stack'}</button>}>
        {suggest && <DetectPanel canDetect detect={() => api<StackDetection>('/api/projects/detect', 'POST', { projectId: project.id })} guidance={guidance} onGuidance={setGuidance} drafts={drafts} onDrafts={setDrafts} setupCommand={setup} onSetup={setSetup}/>}
      </ChecksSection>
      <ScopeSection scope={scope} onScope={setScope} modules={modules} onModules={setModules}/>
      <AdvancedSection guidance={guidance} onGuidance={setGuidance} executionMode={executionMode} onMode={setExecutionMode} setup={setup} onSetup={setSetup} allowScaffold={allowScaffold} onScaffold={setAllowScaffold}>
      <Field label="Thư mục mutation" hint="Để trống để tự nhận diện; monorepo dùng đường dẫn package tương đối, ví dụ packages/api. Dấu . là gốc repo."><input value={mutationRoot} onChange={e => setMutationRoot(e.target.value)}/></Field>
        <Field label="Lệnh chạy thử app (tuỳ chọn)" hint='Cho nút "Chạy thử" trên trang việc; app nhận cổng qua biến PORT. Để trống thì tự đoán (npm run dev, npm start, node server.mjs, index.html).'>
          <input className="mono" value={preview} onChange={(e) => setPreview(e.target.value)} placeholder="npm run dev" spellCheck={false}/></Field>
      </AdvancedSection>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="modal-footer"><span className="pf-foot">Lưu thay đổi sẽ tăng phiên bản policy và cần duyệt lại.</span>
        <button type="button" className="button" onClick={onClose}>Huỷ</button><button className="button primary" disabled={busy}>{busy ? 'Đang lưu…' : 'Lưu thay đổi'}</button></div>
    </form>
  </Modal>;
}
