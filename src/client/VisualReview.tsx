import { useState } from 'react';
import type { RunDetail } from '../shared/types';
import type { VisualProfile } from '../shared/visual';
import { api } from './api';
import { Badge, Field } from './ui';

export function VisualProfileFields({ profile, onChange }: { profile: VisualProfile; onChange: (p: VisualProfile) => void }) {
  return <div className="visual-profile">
    <Field label="Đường dẫn màn hình" hint="{nodeId} được thay bằng node của ảnh Figma. Ví dụ /?state={nodeId}."><input value={profile.pathTemplate} onChange={e => onChange({ ...profile, pathTemplate: e.target.value })} placeholder="/?state={nodeId}"/></Field>
    <Field label="Đợi phần tử sẵn sàng (tùy chọn)"><input value={profile.readySelector ?? ''} onChange={e => { const { readySelector: _old, ...rest } = profile; onChange({ ...rest, ...(e.target.value.trim() ? { readySelector: e.target.value.trim() } : {}) }); }} placeholder="#app"/></Field>
    <Field label="Sai lệch pixel cho phép (%)" hint="Để trống: chỉ đo, chưa tự kết luận khớp. Ngưỡng cần phù hợp yêu cầu của project; tối đa 20%."><input type="number" min={0} max={20} step={0.1} value={profile.maxDiffRatio === undefined ? '' : Number((profile.maxDiffRatio * 100).toFixed(4))} onChange={e => { const { maxDiffRatio: _old, ...rest } = profile; onChange({ ...rest, ...(e.target.value !== '' ? { maxDiffRatio: Number(e.target.value) / 100 } : {}) }); }}/></Field>
    <Field label="Chênh màu được bỏ qua (%)" hint="Áp dụng cùng một quy tắc cho so ảnh Figma và kiểm tra ổn định giữa ba lượt chụp."><input type="number" min={0} max={30} step={1} value={Math.round(profile.pixelThreshold * 100)} onChange={e => onChange({ ...profile, pixelThreshold: Number(e.target.value) / 100 })}/></Field>
    <details className="visual-scope"><summary>Phạm vi và vùng chụp riêng</summary><p className="small muted">Để trống danh sách: kiểm tra mọi ảnh screen trong target. Khi chọn riêng, report luôn liệt kê các ảnh chưa kiểm tra. Selector dùng để chụp thành phần như thông báo, trong viewport đã chọn.</p>
      {(profile.screens ?? []).map((s, i) => <div className="visual-mapping" key={i}>
        <input aria-label={`Node màn hình ${i + 1}`} placeholder="1:4140" value={s.nodeId} onChange={e => onChange({ ...profile, screens: profile.screens!.map((v, j) => j === i ? { ...v, nodeId: e.target.value } : v) })}/>
        <input aria-label={`Selector màn hình ${i + 1}`} placeholder="Toàn màn hình" value={s.selector ?? ''} onChange={e => onChange({ ...profile, screens: profile.screens!.map((v, j) => { if (j !== i) return v; const { selector: _old, ...rest } = v; return { ...rest, ...(e.target.value ? { selector: e.target.value } : {}) }; }) })}/>
        <button type="button" className="text-button" onClick={() => onChange({ ...profile, screens: profile.screens!.map((v, j) => j === i ? { ...v, viewport: { width: 1440, height: 1024 } } : v) })}>{s.viewport ? `${s.viewport.width}×${s.viewport.height}` : 'Dùng viewport 1440×1024'}</button>
        <button type="button" className="text-button" onClick={() => { const list = profile.screens!.filter((_, j) => j !== i), { screens: _old, ...rest } = profile; onChange({ ...rest, ...(list.length ? { screens: list } : {}) }); }}>Bỏ</button>
      </div>)}
      <button type="button" className="text-button" onClick={() => onChange({ ...profile, screens: [...(profile.screens ?? []), { nodeId: '' }] })}>Thêm màn hình vào phạm vi</button>
    </details>
  </div>;
}

const STATUS = { passed: 'Trong ngưỡng', different: 'Vượt ngưỡng', needs_review: 'Đã đo · cần đối chiếu', unstable: 'Ảnh không ổn định', incomplete: 'Chưa kiểm tra được' };

export function VisualReview({ detail, onChanged }: { detail: RunDetail; onChanged: () => void }) {
  const { run, visual } = detail;
  const [profile, setProfile] = useState<VisualProfile>(run.configSnapshot.visualCheck ?? { pathTemplate: '/', pixelThreshold: 0.1 });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [editing, setEditing] = useState(!run.configSnapshot.visualCheck);
  if (!run.contract.design) return null;
  const canRun = ['blocked', 'failed', 'paused', 'awaiting_acceptance'].includes(run.status) && !!run.checkpoint && run.mode !== 'compare' && run.provider !== 'fake' && run.delivery?.status !== 'in_progress';
  const start = async () => {
    setBusy(true); setError('');
    try { await api(`/api/runs/${run.id}/visual-check`, 'POST', { ...(editing ? { profile } : {}) }); setEditing(false); onChanged(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const imageUrl = (file: string) => `/api/runs/${run.id}/visual-files/${visual!.id}/${file}`;
  return <section className="panel visual-review" aria-label="Đối chiếu hình thức với Figma">
    <div className="card-head"><h2>Đối chiếu hình thức với Figma</h2>{visual && <Badge tone={visual.status === 'passed' ? 'good' : visual.status === 'incomplete' ? 'warn' : 'info'}>{visual.profile.maxDiffRatio === undefined ? `${visual.screens.filter(s => s.changedRatio !== undefined).length}/${visual.screens.length} đã đo` : `${visual.screens.filter(s => s.status === 'passed').length}/${visual.screens.length} trong ngưỡng`}</Badge>}</div>
    <p className="muted small">Chạy ứng dụng từ checkpoint sạch, chụp mỗi màn hình ba lần và so với ảnh Figma. Test hành vi và kết quả so ảnh được ghi riêng.</p>
    {!visual && <p className="notice-line">{run.configSnapshot.visualCheck ? 'Chưa có report hình ảnh cho checkpoint này.' : 'Cấu hình đường dẫn một lần cho project để hệ thống tự kiểm tra các task tiếp theo.'}</p>}
    {editing && <VisualProfileFields profile={profile} onChange={setProfile}/>}
    <div className="row-actions"><button type="button" className="button secondary" disabled={!canRun || busy} onClick={() => void start()}>{busy ? 'Đang yêu cầu…' : editing ? 'Duyệt profile và kiểm tra' : 'Chạy lại kiểm tra hình thức'}</button>
      <button type="button" className="text-button" onClick={() => setEditing(v => !v)}>{editing ? 'Ẩn cấu hình' : 'Sửa profile hình thức'}</button></div>
    <p className="small muted">Không gọi AI. Profile này được lưu cho project; hợp đồng nghiệm thu giữ nguyên.</p>
    {error && <p role="alert" className="inline-error">{error}</p>}
    {visual && <>
      <p className="small muted">Checkpoint {visual.checkpoint.slice(0, 8)} · Chromium {visual.browser ?? 'chưa khởi động'} · Ngưỡng {visual.profile.maxDiffRatio === undefined ? 'chưa đặt' : `${(visual.profile.maxDiffRatio * 100).toFixed(2)}%`}</p>
      {visual.limitations.length > 0 && <details><summary>Giới hạn của phép kiểm tra</summary><ul className="plain-list">{visual.limitations.map((l, i) => <li key={i} className="small">{l}</li>)}</ul></details>}
      <div className="visual-screens">{visual.screens.map(s => <details key={s.nodeId} className="visual-screen">
        <summary><strong>{s.name} · {s.nodeId}</strong> <Badge tone={s.status === 'passed' ? 'good' : s.status === 'different' ? 'bad' : 'warn'}>{STATUS[s.status]}</Badge>{s.changedRatio !== undefined && <span className="mono small">{(s.changedRatio * 100).toFixed(2)}% pixel khác</span>}</summary>
        <p className="small">{s.message} · {s.width}×{s.height} · <code>{s.route}</code></p>
        {s.stabilityDiff && <p className="small">Ảnh thay đổi {((s.stabilityRatio ?? 0) * 100).toFixed(4)}% giữa các lượt. <a href={imageUrl(s.stabilityDiff)} target="_blank" rel="noreferrer">Xem vùng không ổn định</a>{s.repeats?.map((file, i) => <span key={file}> · <a href={imageUrl(file)} target="_blank" rel="noreferrer">Lượt {i + 2}</a></span>)}</p>}
        <div className="visual-images">{([['reference', 'Figma'], ['actual', 'Ứng dụng'], ['diff', 'Sai lệch (màu hồng)']] as const).map(([key, title]) => s[key] && <figure key={key}><figcaption>{title}</figcaption><a href={imageUrl(s[key]!)} target="_blank" rel="noreferrer"><img loading="lazy" src={imageUrl(s[key]!)} alt={`${title} · ${s.nodeId}`}/></a></figure>)}</div>
      </details>)}</div>
    </>}
  </section>;
}
