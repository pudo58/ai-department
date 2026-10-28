import { useEffect, useState } from 'react';
import type { SnapshotDiagnostics } from '../shared/design';
import { api } from './api';

export function DesignDiagnostics({ snapshotId, onNode }: { snapshotId: string; onNode: (nodeId: string) => void }) {
  const [report, setReport] = useState<SnapshotDiagnostics | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api<SnapshotDiagnostics>(`/api/design-snapshots/${snapshotId}/diagnostics`).then((r) => { if (active) setReport(r); }).catch((e) => { if (active) setError((e as Error).message); });
    return () => { active = false; };
  }, [snapshotId]);
  if (error) return <p className="notice-line warn">Chưa phân tích được chi tiết: {error}. Các cảnh báo gốc vẫn được giữ phía trên.</p>;
  if (!report) return <p className="muted">Đang phân loại cảnh báo theo dữ liệu snapshot…</p>;
  if (!report.groups.length) return null;
  return <section className="design-diagnostics" aria-label="Chi tiết cảnh báo">
    <h3>Chi tiết cảnh báo</h3>
    <p className="muted">Phân loại từ dữ liệu đã lưu. Danh sách này giúp kiểm tra từng node; việc xác nhận giới hạn vẫn thực hiện ở trên.</p>
    {report.groups.map((group) => <DiagnosticGroup key={group.kind} group={group} onNode={onNode}/>)}
  </section>;
}

function DiagnosticGroup({ group, onNode }: { group: SnapshotDiagnostics['groups'][number]; onNode: (nodeId: string) => void }) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const filtered = group.items.filter((i) => `${i.nodeId} ${i.name} ${i.path} ${i.component?.name ?? ''} ${i.component?.nodeId ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  const pages = Math.max(1, Math.ceil(filtered.length / 20)), current = Math.min(page, pages - 1);
  return <details className="diagnostic-group">
    <summary>{group.title} ({group.items.length})</summary>
    <p>{group.explanation}</p>
    <input aria-label={`Tìm trong ${group.title}`} placeholder="Tìm tên, node ID hoặc component gốc…" value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }}/>
    <p className="muted">{filtered.length} / {group.items.length} mục</p>
    <ul className="diagnostic-items">{filtered.slice(current * 20, current * 20 + 20).map((item, i) => <li key={`${item.nodeId}-${i}`}>
      <button type="button" className="button small" onClick={() => onNode(item.nodeId)}>{item.name} · {item.nodeId}</button>
      <small>{item.nodeType} · {item.path}</small>
      {item.component && <small>Component gốc: {item.component.name} · {item.component.nodeId}</small>}
      {item.hiddenBy && <small>Layer đang ẩn: {item.hiddenBy.name} · {item.hiddenBy.nodeId}</small>}
      <details><summary>Lỗi / lý do gốc</summary><p>{item.reason}</p></details>
    </li>)}</ul>
    {pages > 1 && <div className="actions"><button className="button small" disabled={!current} onClick={() => setPage(current - 1)}>Trước</button><span>{current + 1}/{pages}</span><button className="button small" disabled={current === pages - 1} onClick={() => setPage(current + 1)}>Sau</button></div>}
  </details>;
}
