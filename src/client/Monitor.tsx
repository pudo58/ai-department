import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { time } from './MonitorCharts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface LogEntry { id: number; ts: string; runId: string | null; attemptId?: string; source: string; level: LogLevel; message: string }

const MAX_LINES = 3000;
const SOURCES: [string, string][] = [['', 'Mọi nguồn'], ['run', 'Sự kiện task'], ['setup', 'Cài đặt / bản sao'], ['agent', 'Agent'], ['check', 'Check / test']];

/** Re-renders every `ms` so relative times and running timers stay current. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}
/**
 * Live console. History comes from /api/logs, then a Server-Sent Events stream continues from the last id.
 * On a dropped connection it reconnects from the newest id it has, and ignores anything it already holds.
 */
export function LogConsole({ runId, height = 420, source: fixedSource, compact = false }: { runId?: string; height?: number; /** Pin the console to one source, e.g. "check". */ source?: string; /** Hide the filter controls. */ compact?: boolean }) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [level, setLevel] = useState<LogLevel>('info');
  const [source, setSource] = useState(fixedSource ?? '');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [state, setState] = useState<'connecting' | 'live' | 'offline'>('connecting');
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const lastId = useRef(0);

  useEffect(() => { const t = setTimeout(() => setDebounced(query.trim()), 300); return () => clearTimeout(t); }, [query]);

  useEffect(() => {
    let closed = false;
    let stream: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const params = () => {
      const p = new URLSearchParams({ level });
      if (runId) p.set('run', runId); if (source) p.set('source', source); if (debounced) p.set('q', debounced);
      return p;
    };
    const connect = () => {
      if (closed) return;
      const p = params(); p.set('after', String(lastId.current));
      stream = new EventSource(`/api/logs/stream?${p}`);
      stream.onopen = () => setState('live');
      stream.onmessage = (event) => {
        const entry = JSON.parse(event.data) as LogEntry;
        if (entry.id <= lastId.current) return;
        lastId.current = entry.id;
        setEntries((current) => [...current.slice(-(MAX_LINES - 1)), entry]);
      };
      stream.onerror = () => { stream?.close(); setState('offline'); retry = setTimeout(connect, 1500); };
    };
    setState('connecting'); setEntries([]); lastId.current = 0;
    const p = params(); p.set('limit', '400');
    // Take the newest id of ANY entry first, then the filtered history: everything newer than max(tip, history tail)
    // is guaranteed to arrive on the stream, and nothing older is replayed.
    void (async () => {
      const tip = (await api<LogEntry[]>('/api/logs?limit=1'))[0]?.id ?? 0;
      const history = await api<LogEntry[]>(`/api/logs?${p}`);
      if (closed) return;
      setEntries(history);
      lastId.current = Math.max(tip, history.at(-1)?.id ?? 0);
      connect();
    })().catch(() => { if (!closed) { setState('offline'); retry = setTimeout(connect, 1500); } });
    return () => { closed = true; stream?.close(); if (retry) clearTimeout(retry); };
  }, [runId, level, source, debounced]);

  useEffect(() => { if (follow && box.current) box.current.scrollTop = box.current.scrollHeight; }, [entries, follow]);
  const onScroll = () => { const el = box.current; if (el) setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 32); };

  const download = () => {
    const text = entries.map((e) => `${e.ts} [${e.level}] ${e.source} ${e.runId ?? ''} ${e.message}`).join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a'); a.href = url; a.download = `ai-department-${runId ?? 'all'}.log`; a.click(); URL.revokeObjectURL(url);
  };

  return <div className="console-card">
    <div className="console-bar">
      <span className={`dot dot-${state}`} title={state}/><strong>{state === 'live' ? 'Trực tiếp' : state === 'connecting' ? 'Đang kết nối' : 'Mất kết nối, đang thử lại'}</strong>
      {!compact && <>
        <select aria-label="Mức log" value={level} onChange={(e) => setLevel(e.target.value as LogLevel)}><option value="debug">Tất cả (debug)</option><option value="info">Info+</option><option value="warn">Cảnh báo+</option><option value="error">Chỉ lỗi</option></select>
        <select aria-label="Nguồn log" value={source} onChange={(e) => setSource(e.target.value)}>{SOURCES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></>}
      {!compact && <>
        <input aria-label="Tìm trong log" type="search" placeholder="Tìm trong log…" value={query} onChange={(e) => setQuery(e.target.value)}/>
        <button className="text-button" onClick={() => setEntries([])}>Xóa màn hình</button>
        <button className="text-button" onClick={download} disabled={!entries.length}>Tải về</button></>}
    </div>
    <div className="console" ref={box} onScroll={onScroll} style={{ height }} role="log" aria-live="off">
      {!entries.length && <p className="console-empty">Chưa có dòng log nào khớp bộ lọc. Log mới sẽ hiện ở đây ngay khi phát sinh.</p>}
      {entries.map((e) => <div key={e.id} className={`log-line level-${e.level}`}>
        <time>{time(e.ts)}</time><span className="log-src">{e.source}</span>
        {!runId && e.runId && <a className="log-run" href={`#/run/${e.runId}`}>{e.runId.slice(4, 10)}</a>}
        <span className="log-msg">{e.message}</span></div>)}
    </div>
    {!follow && <button className="console-follow" onClick={() => setFollow(true)}>↓ Theo dõi dòng mới nhất</button>}
  </div>;
}

// ------------------------------------------------------------------ usage & analytics

