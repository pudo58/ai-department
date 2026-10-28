import { useEffect, useRef, useState } from 'react';
import type { DesignSnapshot, SnapshotPreview, SnapshotPreviews } from '../shared/design';
import { api } from './api';

const LABEL = { overview: 'Tổng quan', screen: 'Màn hình', detail: 'Vùng chi tiết' };
const PAGE_SIZE = 12;
const imageUrl = (snapshotId: string, image: SnapshotPreview) => `/api/design-snapshots/${snapshotId}/files/${image.fileId}`;

/** Images are indexed by node and purpose, rather than selected from arbitrary PNG assets. */
export function DesignPreviews({ snap }: { snap: DesignSnapshot }) {
  const [catalog, setCatalog] = useState<SnapshotPreviews | null>(null);
  const [error, setError] = useState('');
  const [kind, setKind] = useState<SnapshotPreview['role']>('screen');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<SnapshotPreview | null>(null);
  const [actualSize, setActualSize] = useState(false);
  const viewer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) { viewer.current?.focus({ preventScroll: true }); viewer.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); }
  }, [selected]);
  useEffect(() => {
    let active = true;
    setCatalog(null); setError(''); setSelected(null); setPage(0); setQuery('');
    api<SnapshotPreviews>(`/api/design-snapshots/${snap.id}/previews`).then((result) => {
      if (!active) return;
      setCatalog(result); setKind(result.images.some((p) => p.role === 'screen') ? 'screen' : 'overview');
    }).catch((e) => { if (active) setError((e as Error).message); });
    return () => { active = false; };
  }, [snap.id, snap.snapshotHash]);
  if (error) return <p className="notice-line warn">Không tải được ảnh thiết kế: {error}</p>;
  if (!catalog) return <p className="muted">Đang tải ảnh thiết kế…</p>;
  if (!catalog.images.length) return <p className="muted">Snapshot chưa có ảnh xem trước. Cập nhật Exporter và export lại để bổ sung ảnh màn hình.</p>;
  const images = catalog.images.filter((p) => p.role === kind && `${p.name} ${p.nodeId}`.toLowerCase().includes(query.trim().toLowerCase()));
  const pages = Math.max(1, Math.ceil(images.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  return <section className="design-previews" aria-label="Ảnh thiết kế">
    <h3>Ảnh thiết kế theo màn hình</h3>
    <p className="muted">Ảnh dùng để đối chiếu cùng dữ liệu node, style và tài nguyên. Bấm ảnh để xem lớn; chọn 1:1 để đọc chi tiết.</p>
    {catalog.warnings.slice(0, 8).map((warning, i) => <p className="notice-line warn" key={i}>{warning}</p>)}
    {catalog.warnings.length > 8 && <p className="muted">Còn {catalog.warnings.length - 8} cảnh báo; xem previews.json và tab Giới hạn.</p>}
    {!catalog.images.some((p) => p.role === 'screen') && <p className="notice-line warn">Snapshot này chỉ có ảnh tổng quan. Cập nhật Exporter và export lại Section để lấy ảnh riêng từng màn hình.</p>}
    <div className="tabs" role="tablist" aria-label="Loại ảnh thiết kế">{(Object.keys(LABEL) as SnapshotPreview['role'][]).map((role) =>
      <button key={role} type="button" role="tab" aria-selected={kind === role} onClick={() => { setKind(role); setPage(0); }}>{LABEL[role]} ({catalog.images.filter((p) => p.role === role).length})</button>)}</div>
    <input aria-label="Tìm ảnh theo tên hoặc node ID" placeholder="Tìm tên màn hình hoặc node ID…" value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }}/>
    <div className="design-preview-grid">{images.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map((image, i) =>
      <button type="button" className="design-preview-card" key={`${image.nodeId}-${image.role}-${image.region?.x}-${image.region?.y}-${i}`}
        aria-label={`Mở ${LABEL[image.role].toLowerCase()}: ${image.name} (${image.nodeId})`} onClick={() => { setSelected(image); setActualSize(false); }}>
        <img loading="lazy" src={imageUrl(snap.id, image)} alt={`${LABEL[image.role]} ${image.name}`} width={240} height={160}/>
        <strong>{image.name}</strong><small>{image.nodeType} · {image.nodeId}</small>
        <small>{image.width && image.height ? `${image.width} × ${image.height} px` : 'Kích thước chưa được ghi'}{image.scale && image.scale < 1 ? ` · thu nhỏ ${Math.round(image.scale * 100)}%` : ''}</small>
        {image.region && <small>Vùng x={Math.round(image.region.x)}, y={Math.round(image.region.y)}</small>}
      </button>)}</div>
    {!images.length && <p className="muted">Không có ảnh phù hợp.</p>}
    {pages > 1 && <div className="actions" aria-label="Trang ảnh"><button className="button small" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>Trước</button><span>{currentPage + 1}/{pages}</span><button className="button small" disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)}>Sau</button></div>}
    {selected && <div className="design-preview-viewer" ref={viewer} tabIndex={-1} aria-label={`Ảnh lớn ${selected.name}`}>
      <div className="actions"><strong>{selected.name} · {selected.nodeId}</strong>
        <button className="button small" aria-pressed={actualSize} onClick={() => setActualSize(!actualSize)}>{actualSize ? 'Vừa chiều ngang' : 'Xem 1:1'}</button>
        <a className="button small" href={imageUrl(snap.id, selected)} target="_blank" rel="noreferrer">Mở ảnh riêng</a>
        <button className="button small" onClick={() => setSelected(null)}>Đóng ảnh</button></div>
      <div className={`design-preview-canvas${actualSize ? ' actual-size' : ''}`}><img src={imageUrl(snap.id, selected)} alt={`${LABEL[selected.role]} ${selected.name}`} width={selected.width} height={selected.height}/></div>
    </div>}
  </section>;
}
