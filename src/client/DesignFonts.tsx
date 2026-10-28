import { useEffect, useState } from 'react';
import type { FontFamilyResult, SnapshotFonts } from '../shared/fonts';
import { api } from './api';

const STATUS: Record<FontFamilyResult['status'], string> = { ready: 'Đã có file', not_open: 'Không có trong kho mở', failed: 'Tải lỗi' };
const weights = (variants: { weight: number; italic: boolean }[]) => variants.map((v) => `${v.weight}${v.italic ? ' nghiêng' : ''}`).join(', ');

/**
 * The fonts the text of a snapshot uses. Fetching is a request to the internet, so it happens only when the button is pressed, from
 * the two hosts named below, and everything it keeps is listed afterwards.
 */
export function DesignFonts({ snapshotId }: { snapshotId: string }) {
  const [fonts, setFonts] = useState<SnapshotFonts | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    api<SnapshotFonts>(`/api/design-snapshots/${snapshotId}/fonts`).then((r) => { if (active) setFonts(r); }).catch((e) => { if (active) setError((e as Error).message); });
    return () => { active = false; };
  }, [snapshotId]);
  async function fetchFonts() {
    setBusy(true); setError('');
    try { await api(`/api/design-snapshots/${snapshotId}/fonts`, 'POST', { confirm: true }); setFonts(await api<SnapshotFonts>(`/api/design-snapshots/${snapshotId}/fonts`)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  if (error && !fonts) return <p className="notice-line warn">Chưa đọc được danh sách font: {error}</p>;
  if (!fonts) return <p className="muted">Đang đọc font từ dữ liệu snapshot…</p>;
  if (!fonts.uses.length) return null;
  const result = (family: string) => fonts.set?.families.find((f) => f.family === family);
  return <section className="design-fonts" aria-label="Font của thiết kế">
    <h3>Font của thiết kế</h3>
    <p className="muted">Trình duyệt chỉ vẽ đúng font khi có file font trong dự án. Bấm tải để lấy các font mã nguồn mở (Latin, Latin Extended, Vietnamese) từ {fonts.hosts.join(' và ')}; font thương mại không có trong kho sẽ được báo là cần bạn cung cấp. Task dùng snapshot này nhận file trong thư mục fonts/ của design input.</p>
    <ul className="font-list">{fonts.uses.map((use) => {
      const r = result(use.family);
      return <li key={use.family} data-testid="font-row">
        <strong>{use.family}</strong> <small>độ đậm {weights(use.variants)} · {use.nodes} đoạn chữ</small>
        {r ? <small> · {STATUS[r.status]}{r.status === 'ready' ? ` (${r.files.length} file, ${r.license ?? 'giấy phép không rõ'})` : ''}</small> : <small> · chưa tải</small>}
        {r?.notes.map((n, i) => <small key={i} className="muted"> {n}</small>)}
      </li>;
    })}</ul>
    {error && <p className="inline-error">{error}</p>}
    <div className="actions"><button className="button" disabled={busy} onClick={() => void fetchFonts()}>{busy ? 'Đang tải…' : fonts.set ? 'Tải lại font mở' : 'Tải font mở'}</button>{fonts.set && <small className="muted">Lần cuối: {new Date(fonts.set.fetchedAt).toLocaleString('vi-VN')}</small>}</div>
  </section>;
}
