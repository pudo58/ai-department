import { useEffect, useState } from 'react';
import { api } from './api';
import { Icon } from './ui';

interface PreviewState { url: string; command: string[]; stopsAt: string; log: string }

/**
 * Start the run's result on a local port and open it, to try it by hand before accepting. The preview stops by itself
 * after 30 minutes and whenever the run goes back to an agent or is accepted.
 */
export function PreviewButton({ runId }: { runId: string }) {
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void api<{ preview: PreviewState | null }>(`/api/runs/${runId}/preview`).then((r) => { if (alive) setPreview(r.preview); }).catch(() => undefined);
    return () => { alive = false; };
  }, [runId]);
  async function start() {
    setBusy(true); setError('');
    try {
      const r = await api<{ preview: PreviewState }>(`/api/runs/${runId}/preview/start`, 'POST', {});
      setPreview(r.preview);
      window.open(r.preview.url, '_blank', 'noopener');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function stop() {
    setBusy(true);
    try { await api(`/api/runs/${runId}/preview/stop`, 'POST', {}); setPreview(null); } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const until = preview ? new Date(preview.stopsAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '';
  return <span className="preview-control">
    {!preview
      ? <button className="button" disabled={busy} title="Bật app từ đúng bản code của run này trên máy bạn để tự thử trước khi nghiệm thu." onClick={() => void start()}><Icon name="play" size={14}/>{busy ? 'Đang bật app…' : 'Chạy thử'}</button>
      : <><a className="button" href={preview.url} target="_blank" rel="noopener noreferrer" title={`Lệnh: ${preview.command.join(' ')} · tự tắt lúc ${until}`}><Icon name="play" size={14}/>Mở {preview.url.replace('http://', '')}</a>
        <button className="button ghost" disabled={busy} onClick={() => void stop()}>Dừng chạy thử</button></>}
    {error && <span className="inline-error preview-error" role="alert">{error}</span>}
  </span>;
}
