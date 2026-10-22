import { useEffect, useId, useState } from 'react';
import { GUIDANCE_MAX_CHARS } from '../shared/guidance';
import { isExperimental } from '../shared/providers';
import type { Role, RoleConfig, StackDetection } from '../shared/types';
import { api } from './api';
import { formatCommandLine } from './argv';
import { CHECK_PRESETS, draftFromSuggestion, newDraft, sameCommand, type CheckDraft } from './checkdraft';
import { Field } from './ui';

/** Add, edit and remove the project's checks. Each row is one command; a row with no report path is judged by exit code only. */
export function ChecksEditor({ drafts, onChange }: { drafts: CheckDraft[]; onChange: (next: CheckDraft[]) => void }) {
  const patch = (key: string, change: Partial<CheckDraft>) => onChange(drafts.map((d) => (d.key === key ? { ...d, ...change } : d)));
  return <div className="field checks-editor">
    <span>Check của project <small className="muted">({drafts.length})</small></span>
    {drafts.map((d, index) => <fieldset className="check-edit" key={d.key}>
      <legend className="sr-only">Check {index + 1}</legend>
      <div className="check-main">
        <input aria-label={`Check ${index + 1}: id`} className="mono check-id" value={d.id} maxLength={40} onChange={(e) => patch(d.key, { id: e.target.value })} spellCheck={false}/>
        <input aria-label={`Check ${index + 1}: lệnh`} className="mono" value={d.command} placeholder="npx tsc --noEmit" onChange={(e) => patch(d.key, { command: e.target.value })} spellCheck={false}/>
        <button type="button" className="button ghost small danger-text" onClick={() => onChange(drafts.filter((x) => x.key !== d.key))} disabled={drafts.length === 1} title={drafts.length === 1 ? 'Project cần ít nhất một check' : 'Xóa check này'}>Xóa</button>
      </div>
      <div className="check-opts">
        <label className="inline-check"><input type="checkbox" checked={d.required} onChange={(e) => patch(d.key, { required: e.target.checked })}/>Bắt buộc</label>
        <label className="check-opt">Report<input aria-label={`Check ${index + 1}: đường dẫn report`} className="mono" value={d.reportPath} placeholder="trống = chỉ xét exit code" onChange={(e) => patch(d.key, { reportPath: e.target.value })} spellCheck={false}/></label>
        <label className="check-opt narrow-opt">Timeout (giây)<input aria-label={`Check ${index + 1}: timeout giây`} type="number" min={1} max={3600} value={d.timeoutSec} onChange={(e) => patch(d.key, { timeoutSec: Number(e.target.value) })}/></label>
      </div>
      {!d.reportPath.trim() && <small className="muted">Không có report: exit code 0 là pass, khác 0 là fail, output hiện trong Console. Không được tính là bằng chứng cho yêu cầu.</small>}
    </fieldset>)}
    <div className="row-actions"><span className="muted small">Thêm từ mẫu:</span>{CHECK_PRESETS.map((p) => <button key={p.label} type="button" className="button secondary small" title={p.hint} onClick={() => onChange([...drafts, newDraft(p, drafts)])}>{p.label}</button>)}
      <button type="button" className="button secondary small" onClick={() => onChange([...drafts, newDraft({ id: 'check', command: [] }, drafts)])}>+ Check trống</button></div>
    <small>Chạy lần lượt, không qua shell (trên Windows dùng npm, npx hoặc node). Check bắt buộc phải pass thì việc mới nghiệm thu được.</small>
  </div>;
}

/** Owner's notes for the agents, capped; the counter turns red at the limit. */
export function GuidanceField({ value, onChange }: { value: string; onChange: (text: string) => void }) {
  const count = value.length;
  return <Field label={`Hướng dẫn cho AI (${count}/${GUIDANCE_MAX_CHARS})`} hint="Stack, quy ước, điều cần tránh. AI chỉ đọc để tham khảo, không bao giờ chạy nội dung này.">
    <textarea rows={6} maxLength={GUIDANCE_MAX_CHARS} value={value} onChange={(e) => onChange(e.target.value)} className={count >= GUIDANCE_MAX_CHARS ? 'at-limit' : ''} placeholder={'Ví dụ:\nStack: TypeScript, React 19, Fastify, vitest.\nQuy ước: ESM, import có đuôi .js, không dùng any.\nTránh: thêm dependency, sửa lockfile.'} spellCheck={false}/>
  </Field>;
}

/**
 * Runs the read-only detector and shows what it found. Nothing is applied behind the person's back except filling an
 * empty guidance box; checks and the setup command are added only when they click.
 */
export function DetectPanel({ detect, canDetect, guidance, onGuidance, drafts, onDrafts, setupCommand, onSetup }: {
  detect: () => Promise<StackDetection>; canDetect: boolean; guidance: string; onGuidance: (text: string) => void;
  drafts: CheckDraft[]; onDrafts: (next: CheckDraft[]) => void; setupCommand: string; onSetup?: (json: string) => void;
}) {
  const [result, setResult] = useState<StackDetection | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const id = useId();
  async function run() {
    setBusy(true); setError('');
    try {
      const found = await detect();
      setResult(found); setSelected(new Set(found.checks.filter((c) => c.recommended).map((c) => c.id)));
      if (!guidance.trim() && found.guidance) onGuidance(found.guidance);
    } catch (e) { setError((e as Error).message); setResult(null); }
    finally { setBusy(false); }
  }
  const addSelected = () => {
    if (!result) return;
    let next = drafts;
    for (const s of result.checks.filter((c) => selected.has(c.id))) {
      if (next.some((d) => sameCommand(d, s.command))) continue;
      next = [...next, draftFromSuggestion(s, next)];
    }
    onDrafts(next);
  };
  const suggestedSetup = result ? formatCommandLine(result.setupCommand) : '';
  return <section className="detect-panel" aria-labelledby={id}>
    <div className="detect-head"><div><strong id={id}>Phát hiện stack</strong><small className="muted">Chỉ đọc package.json, lockfile, tsconfig và file cấu hình trong repo; không chạy lệnh nào. Kết quả chỉ là gợi ý.</small></div>
      <button type="button" className="button secondary" onClick={() => void run()} disabled={busy || !canDetect}>{busy ? 'Đang đọc…' : result ? 'Phát hiện lại' : 'Phát hiện stack'}</button></div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {result && <div className="detect-result">
      <div className="chip-row">{[...result.languages, ...result.frameworks, ...(result.testRunner ? [`test: ${result.testRunner}`] : []), ...result.linters, ...(result.packageManager ? [result.packageManager] : [])].map((c) => <span className="chip" key={c}>{c}</span>)}</div>
      {result.notes.map((n) => <p className="notice-line" key={n}>{n}</p>)}
      <div className="detect-block"><div className="detect-block-head"><strong>Hướng dẫn gợi ý</strong>
        <button type="button" className="button secondary small" disabled={guidance === result.guidance || !result.guidance} onClick={() => onGuidance(result.guidance)}>{guidance === result.guidance ? 'Đã dùng' : guidance.trim() ? 'Thay hướng dẫn hiện tại' : 'Dùng'}</button></div>
        <pre className="detect-pre">{result.guidance || '(không có)'}</pre></div>
      <div className="detect-block"><div className="detect-block-head"><strong>Check gợi ý</strong>
        <button type="button" className="button secondary small" disabled={!selected.size} onClick={addSelected}>Thêm {selected.size} check đã chọn</button></div>
        {!result.checks.length ? <p className="muted small">Không có gợi ý check.</p> : <ul className="detect-checks">{result.checks.map((c) => {
          const exists = drafts.some((d) => sameCommand(d, c.command));
          return <li key={c.id}><label><input type="checkbox" checked={selected.has(c.id)} onChange={(e) => setSelected((cur) => { const next = new Set(cur); if (e.target.checked) next.add(c.id); else next.delete(c.id); return next; })}/><span><strong>{c.label}</strong> <code>{c.command.join(' ')}</code>{exists && <em className="muted"> · đã có</em>}<small>{c.reason}</small></span></label></li>;
        })}</ul>}</div>
      {onSetup && result.setupCommand.length > 0 && <div className="detect-block"><div className="detect-block-head"><span>Lệnh cài đặt gợi ý: <code>{result.setupCommand.join(' ')}</code></span>
        <button type="button" className="button secondary small" disabled={setupCommand === suggestedSetup} onClick={() => onSetup(suggestedSetup)}>{setupCommand === suggestedSetup ? 'Đã dùng' : 'Dùng'}</button></div></div>}
    </div>}
  </section>;
}

/** Module entry meaning "the whole repository"; protected files (lockfiles, configs, locked tests) stay off limits. */
export const ALL_MODULES = '**';

const ROLE_INFO: [Role, string, string][] = [
  ['planner', 'Planner', 'Đọc yêu cầu, đề xuất hợp đồng nghiệm thu'],
  ['developer', 'Developer', 'Viết code và sửa lỗi'],
  ['author', 'Author', 'Viết test nghiệm thu độc lập (chế độ Verify)'],
  ['verifier', 'Verifier', 'Soát diff, tìm lỗi (chế độ Verify)'],
  ['investigator', 'Investigator', 'Đọc yêu cầu độc lập (chế độ Clarify)'],
];
const SUGGESTED: Record<Role, 'codex' | 'claude'> = { planner: 'codex', developer: 'codex', author: 'claude', verifier: 'claude', investigator: 'claude' };
export interface CliReady { id: 'codex' | 'claude' | 'antigravity'; installed: boolean; loggedIn: boolean; models?: string[] }

/** Which agent CLIs are installed and signed in on this machine; null until known (or when the check fails). */
export function useCliReady(): CliReady[] | null {
  const [ready, setReady] = useState<CliReady[] | null>(null);
  useEffect(() => { void api<CliReady[]>('/api/providers').then(setReady).catch(() => setReady(null)); }, []);
  return ready;
}
export const cliOk = (ready: CliReady[] | null, id: string) => !!ready?.find((r) => r.id === id && r.installed && r.loggedIn);

/** One-click splits of the five roles; "custom" is anything else. */
export type RolePreset = 'split' | 'codex' | 'claude';
export const ROLE_PRESETS: { id: RolePreset; label: string; desc: string; needs: ('codex' | 'claude')[] }[] = [
  { id: 'split', label: 'Codex + Claude', desc: 'Codex viết code, Claude viết test và soát. Khác hãng nên dễ bắt lỗi hơn.', needs: ['codex', 'claude'] },
  { id: 'codex', label: 'Chỉ Codex', desc: 'Mọi vai dùng tài khoản ChatGPT.', needs: ['codex'] },
  { id: 'claude', label: 'Chỉ Claude', desc: 'Mọi vai dùng tài khoản Claude.', needs: ['claude'] },
];
export const rolesFor = (preset: RolePreset, base: Record<Role, RoleConfig>): Record<Role, RoleConfig> =>
  Object.fromEntries(ROLE_INFO.map(([r]) => [r, { ...base[r], provider: preset === 'split' ? SUGGESTED[r] : preset, model: '' }])) as Record<Role, RoleConfig>;
/** The preset a role table matches, ignoring models and effort; null when it is a custom mix. */
export const presetOf = (roles: Record<Role, RoleConfig>): RolePreset | null =>
  ROLE_PRESETS.find((p) => ROLE_INFO.every(([r]) => roles[r].provider === (p.id === 'split' ? SUGGESTED[r] : p.id)))?.id ?? null;
/** Default for a new project: the split when both CLIs are ready, otherwise whichever one is. */
export const defaultPreset = (ready: CliReady[] | null): RolePreset => (cliOk(ready, 'codex') && cliOk(ready, 'claude') ? 'split' : cliOk(ready, 'claude') && !cliOk(ready, 'codex') ? 'claude' : cliOk(ready, 'codex') ? 'codex' : 'split');
const EFFORT_HINT: Record<RoleConfig['provider'], string> = {
  codex: 'Mức suy nghĩ của Codex', claude: 'Claude Code tự chọn mức suy nghĩ; ô này chỉ áp dụng cho Codex', fake: '',
  antigravity: 'Mức suy nghĩ của Antigravity; bỏ qua khi tên model đã ghi mức (ví dụ …-high)',
};

/**
 * Who does what: provider, model and effort per role. Shows which CLIs are ready on this machine and offers the
 * suggested split (Codex writes, Claude tests and reviews). Skills are kept as they are.
 */
export function RolesEditor({ value, onChange, presets = true }: { value: Record<Role, RoleConfig>; onChange: (next: Record<Role, RoleConfig>) => void; presets?: boolean }) {
  const ready = useCliReady();
  const ok = (id: string) => cliOk(ready, id);
  const set = (role: Role, patch: Partial<RoleConfig>) => onChange({ ...value, [role]: { ...value[role], ...patch } });
  const notReady = ROLE_INFO.filter(([r]) => ready && !ok(value[r].provider)).map(([, l]) => l);
  const experimental = ROLE_INFO.filter(([r]) => isExperimental(value[r].provider, r)).map(([, l]) => l);
  return <div className="field roles-editor">
    {presets && <span>Ai làm việc gì</span>}
    {presets && <div className="row-actions" style={{ marginTop: 0 }}>
      <button type="button" className="button secondary small" onClick={() => onChange(Object.fromEntries(ROLE_INFO.map(([r]) => [r, { ...value[r], provider: SUGGESTED[r] }])) as Record<Role, RoleConfig>)}>Gợi ý: Codex viết code, Claude viết test và soát</button>
      <button type="button" className="button ghost small" onClick={() => onChange(Object.fromEntries(ROLE_INFO.map(([r]) => [r, { ...value[r], provider: 'codex' }])) as Record<Role, RoleConfig>)}>Tất cả Codex</button>
      <button type="button" className="button ghost small" onClick={() => onChange(Object.fromEntries(ROLE_INFO.map(([r]) => [r, { ...value[r], provider: 'claude' }])) as Record<Role, RoleConfig>)}>Tất cả Claude</button>
      {ok('antigravity') && value.verifier.provider !== 'antigravity' && <button type="button" className="button ghost small" onClick={() => set('verifier', { provider: 'antigravity', model: '' })}>Antigravity soát (Verifier)</button>}
    </div>}
    <div className="roles-table">{ROLE_INFO.map(([role, label, desc]) => <div key={role} className="roles-row">
      <div className="roles-name"><strong>{label}</strong><small>{desc}</small></div>
      <select aria-label={`${label}: provider`} value={value[role].provider} onChange={(e) => set(role, { provider: e.target.value as RoleConfig['provider'], model: '' })}>
        <option value="codex">Codex{ready && !ok('codex') ? ' (chưa sẵn sàng)' : ''}</option><option value="claude">Claude Code{ready && !ok('claude') ? ' (chưa sẵn sàng)' : ''}</option>
        <option value="antigravity">Antigravity{isExperimental('antigravity', role) ? ' (thử nghiệm)' : ''}{ready && !ok('antigravity') ? ' (chưa sẵn sàng)' : ''}</option></select>
      <input aria-label={`${label}: model`} placeholder="Model mặc định" value={value[role].model} onChange={(e) => set(role, { model: e.target.value })} spellCheck={false} list={value[role].provider === 'antigravity' ? 'agy-models' : undefined}/>
      <select aria-label={`${label}: mức suy nghĩ`} value={value[role].effort} onChange={(e) => set(role, { effort: e.target.value })} title={EFFORT_HINT[value[role].provider]}><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select>
    </div>)}</div>
    <datalist id="agy-models">{(ready?.find((r) => r.id === 'antigravity')?.models ?? []).map((m) => <option key={m} value={m}/>)}</datalist>
    {experimental.length > 0 && <p className="notice-line">{experimental.join(', ')}: Antigravity thử nghiệm chỉ sửa được file trong bản sao làm việc và không chạy được lệnh nào; AI Department tự chạy các check sau lượt của nó.</p>}
    {notReady.length > 0 && <p className="notice-line">{notReady.join(', ')} đang dùng một CLI chưa cài hoặc chưa đăng nhập. <a href="#/connect">Mở Kết nối AI</a>.</p>}
    <small>Model trống thì CLI dùng mặc định của nó (ví dụ gpt-6.1-sol, model của gói Claude, hoặc model Antigravity đang chọn). Antigravity làm Developer hoặc Author là thử nghiệm. Đổi vai là thay đổi policy, cần duyệt lại.</small>
  </div>;
}
