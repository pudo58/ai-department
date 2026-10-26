import { useCallback, useEffect, useState } from 'react';
import type { MonitorData, Period, RequestRow } from '../core/monitor';
import { api } from './api';
import { useNow } from './Monitor';
import { AttemptDetail, PERIOD_LABEL } from './MonitorCharts';
import { LiveTab, CostTab, SystemPane } from './MonitorPanels';

/** Three tabs: what happens now, what it costs, and the machine. ('overview' keeps old #/monitor links working.) */
export type MonitorTab = 'overview' | 'cost' | 'system';
export const MONITOR_TABS: [MonitorTab, string][] = [['overview', 'Trực tiếp'], ['cost', 'Chi phí'], ['system', 'Hệ thống']];
/** Links from the five-tab layout land on the tab that now holds that content. */
export function normalizeMonitorTab(arg: string | undefined): MonitorTab {
  if (arg === 'cost' || arg === 'requests' || arg === 'insights' || arg === 'metrics') return 'cost';
  if (arg === 'system') return 'system';
  return 'overview';
}

/** A server started before this page was built sends the older shape; fill the new parts with empties instead of crashing. */
function withDefaults(d: Partial<MonitorData>): MonitorData {
  const totals = d.totals ?? { requests: 0, failed: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, estimated: false };
  return {
    now: new Date().toISOString(), period: 'today', unit: 'hour', byModel: [], activeRuns: [], runningAttempts: [], recent: [], errorsLastHour: 0, tasks: [],
    activity: { providers: [], stages: { setup: false, check: false } },
    previous: { ...totals, requests: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, failed: 0 }, cacheRate: totals.inputTokens ? totals.cachedTokens / totals.inputTokens : 0,
    acceptedInPeriod: 0, costPerAccepted: null, byTask: [], byRole: [], byProject: [], waste: { items: [], costUsd: 0 }, waiting: [], live: [], alerts: [],
    ...d, totals, series: (d.series ?? []).map((b) => ({ ...b, costByRole: b.costByRole ?? {} })),
  } as MonitorData;
}

/** One page for everything that watches the system: where money goes, what runs now, what waits for you, logs and health. */
export function MonitorHub({ tab, onTab }: { tab: MonitorTab; onTab: (tab: MonitorTab) => void }) {
  const [data, setData] = useState<MonitorData | null>(null);
  const [period, setPeriod] = useState<Period>('today');
  const [error, setError] = useState('');
  const [open, setOpen] = useState<RequestRow | null>(null);
  const now = useNow(1000);
  const usageTab = tab === 'overview' || tab === 'cost';
  const load = useCallback(async () => { try { setData(withDefaults(await api<Partial<MonitorData>>(`/api/monitor?period=${period}`))); setError(''); } catch (e) { setError((e as Error).message); } }, [period]);
  // The error badge on the Console tab needs fresh data on every tab, so poll slowly elsewhere.
  useEffect(() => { void load(); const t = setInterval(() => void load(), usageTab ? 2000 : 10_000); return () => clearInterval(t); }, [load, usageTab]);

  return <>
    <header className="page-header">
      <div><span className="kicker">Sổ theo dõi</span><h1>Theo dõi</h1><p>{tab === 'overview' ? 'AI Department đang gọi gì, việc nào đang chạy, việc nào chờ bạn.' : tab === 'cost' ? 'Tiền đi đâu, có lãng phí không, chế độ nào hiệu quả.' : 'Máy, đĩa, bản sao làm việc và các phiên đang mở.'}</p></div>
      {tab === 'cost' && <div className="segmented" role="group" aria-label="Khoảng thời gian">{(Object.keys(PERIOD_LABEL) as Period[]).map((p) => <button key={p} aria-pressed={period === p} className={period === p ? 'active' : ''} onClick={() => setPeriod(p)}>{PERIOD_LABEL[p]}</button>)}</div>}
    </header>
    <div className="tabs" role="tablist" style={{ marginTop: 0 }}>{MONITOR_TABS.map(([key, label]) => <button key={key} role="tab" aria-selected={tab === key} onClick={() => onTab(key)}>
      {label}
      {key === 'overview' && !!data?.waiting.length && <span className="pill" title="Việc đang chờ bạn">{data.waiting.length}</span>}
</button>)}</div>
    {error && <div className="banner error" role="alert">{error}</div>}
    {usageTab && (!data ? <p className="muted">Đang tải…</p> : tab === 'overview' ? <LiveTab data={data} now={now} onOpen={setOpen}/> : <CostTab data={data} now={now} onOpen={setOpen}/>)}
    {tab === 'system' && <SystemPane/>}
    {open && <AttemptDetail attempt={open} onClose={() => setOpen(null)}/>}
  </>;
}

// --------------------------------------------------------------------------- overview

// --------------------------------------------------------------------------- requests

// --------------------------------------------------------------------------- insights

// --------------------------------------------------------------------------- system


