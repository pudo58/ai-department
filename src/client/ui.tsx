import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { pageCount, pageList } from './paging';

export type IconName =
  | 'grid' | 'flow' | 'folder' | 'chart' | 'settings' | 'plus' | 'arrow' | 'check' | 'close' | 'play' | 'pause' | 'clock' | 'terminal'
  | 'shield' | 'layers' | 'search' | 'chevron' | 'sun' | 'moon' | 'laptop' | 'back' | 'alert' | 'info' | 'activity' | 'edit' | 'refresh' | 'trash';
const paths: Record<IconName, ReactNode> = {
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
  flow: <><rect x="3" y="3" width="7" height="6" rx="1.5"/><rect x="14" y="15" width="7" height="6" rx="1.5"/><path d="M6.5 9v8a2 2 0 0 0 2 2H14M10 6h7a2 2 0 0 1 2 2v7"/></>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>,
  chart: <path d="M4 3v17h17M8 16v-5M13 16V7M18 16V4"/>,
  settings: <><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="16" cy="17" r="3"/></>,
  plus: <path d="M12 5v14M5 12h14"/>, arrow: <path d="M5 12h14m-5-5 5 5-5 5"/>,
  check: <path d="m5 12 4 4L19 6"/>, close: <path d="m6 6 12 12M18 6 6 18"/>,
  play: <path d="m8 4 12 8-12 8Z"/>, pause: <path d="M8 5v14M16 5v14"/>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  terminal: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/></>,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/></>,
  layers: <path d="m12 3 10 6-10 6L2 9Zm-9 11 9 5 9-5m-18 5 9 5 9-5"/>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>, chevron: <path d="m9 5 7 7-7 7"/>,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></>,
  moon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>,
  laptop: <><rect x="4" y="5" width="16" height="11" rx="2"/><path d="M2 20h20"/></>,
  back: <path d="m15 5-7 7 7 7"/>,
  alert: <><path d="M12 3 2 20h20Z"/><path d="M12 10v4M12 17.5v.01"/></>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.01"/></>,
  activity: <path d="M3 12h4l3-8 4 16 3-8h4"/>,
  edit: <path d="M4 20h4L19 9l-4-4L4 16Zm9-13 4 4"/>,
  refresh: <path d="M20 11a8 8 0 0 0-14.5-3.5L4 9m0-5v5h5M4 13a8 8 0 0 0 14.5 3.5L20 15m0 5v-5h-5"/>,
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>,
};
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export function Badge({ children, tone = 'neutral', live = false, plain = false }: { children: ReactNode; tone?: string; live?: boolean; plain?: boolean }) {
  return <span className={`badge badge-${tone}${live ? ' live' : ''}${plain ? ' plain' : ''}`}>{children}</span>;
}
export function Empty({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty"><h3>{title}</h3><p>{children}</p>{action}</div>;
}
export type Hue = 'blue' | 'purple' | 'orange' | 'green' | 'red' | 'gray';
/** A rounded tile holding an icon, tinted with one of the pastel hues. */
export function IconTile({ icon, hue, size = 'md' }: { icon: IconName; hue: Hue; size?: 'md' | 'lg' }) {
  return <span className={`icon-tile hue-${hue} tile-${size}`} aria-hidden="true"><Icon name={icon} size={size === 'lg' ? 22 : 18}/></span>;
}
/** Page title with an optional colored icon tile and a one-line summary; actions on the right. */
export function PageHeader({ kicker, icon, hue = 'blue', title, subtitle, children }: { kicker?: string; icon?: IconName; hue?: Hue; title: string; subtitle?: ReactNode; children?: ReactNode }) {
  return <header className="page-header"><div className="page-title">{icon && <IconTile icon={icon} hue={hue} size="lg"/>}<div>{kicker && <span className="kicker">{kicker}</span>}<h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div></div>{children && <div className="header-actions">{children}</div>}</header>;
}
/** Key numbers between two rules, read left to right like a ledger line (replaces rows of KPI cards). */
export function Ledger({ items, className }: { items: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'warn'; title?: string }[]; className?: string }) {
  return <div className={`ledger${className ? ` ${className}` : ''}`}>{items.map((item) => <div className="ledger-item" key={item.label} title={item.title}>
    <span className="kicker">{item.label}</span><span className={`v${item.tone ? ` ${item.tone}` : ''}`}>{item.value}</span>{item.sub && <span className="sub">{item.sub}</span>}
  </div>)}</div>;
}
export function Modal({ title, subtitle, children, onClose, size }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; size?: 'sm' | 'md' }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  return <dialog ref={dialog} className={`modal${size ? ` modal-${size}` : ''}`} aria-labelledby={id} onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => { if (e.target === dialog.current) onClose(); }}>
    <div className="modal-heading"><div><h2 id={id}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button type="button" className="icon-button" onClick={onClose} aria-label="Đóng"><Icon name="close" size={18}/></button></div>
    {children}
  </dialog>;
}
/** Asks before something that cannot be undone. A refusal from the server stays in the dialog instead of closing it. */
export function ConfirmDialog({ title, children, confirmLabel, disabled = false, onConfirm, onClose }: { title: string; children: ReactNode; confirmLabel: string; disabled?: boolean; onConfirm: () => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const confirm = async () => {
    setBusy(true); setError('');
    try { await onConfirm(); } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return <Modal title={title} size="sm" onClose={() => { if (!busy) onClose(); }}>
    <div className="confirm">
      {children}
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="modal-footer"><button type="button" className="button" disabled={busy} onClick={onClose}>Huỷ</button>
        <button type="button" className="button danger" disabled={busy || disabled} onClick={() => void confirm()}>{busy ? 'Đang xoá…' : confirmLabel}</button></div>
    </div>
  </Modal>;
}

/** Under a table: the rows shown, rows per page, and previous / numbered / next page buttons. */
export function Pager({ page, size, total, unit, sizes, onPage, onSize }: { page: number; size: number; total: number; unit: string; sizes: readonly number[]; onPage: (page: number) => void; onSize: (size: number) => void }) {
  const pages = pageCount(total, size);
  const from = total ? (page - 1) * size + 1 : 0, to = Math.min(total, page * size);
  return <nav className="pager" aria-label="Phân trang">
    <span className="pager-range">{from}–{to} / {total} {unit}</span>
    <label className="pager-size"><select aria-label="Số dòng mỗi trang" value={size} onChange={(e) => onSize(Number(e.target.value))}>{sizes.map((n) => <option key={n} value={n}>{n} / trang</option>)}</select></label>
    {pages > 1 && <div className="pager-pages">
      <button className="pager-step" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Trang trước"><Icon name="back" size={14}/></button>
      {pageList(page, pages).map((n, i) => n === '…' ? <span key={`gap-${i}`} className="pager-gap" aria-hidden="true">…</span>
        : <button key={n} className={`pager-num${n === page ? ' active' : ''}`} aria-current={n === page ? 'page' : undefined} aria-label={`Trang ${n}`} onClick={() => onPage(n)}>{n}</button>)}
      <button className="pager-step" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Trang sau"><Icon name="chevron" size={14}/></button>
    </div>}
  </nav>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

/** Unified diff with added/removed/hunk lines tinted, so a patch can be read at a glance. */
export function DiffView({ text }: { text: string }) {
  if (!text.trim()) return <div className="diff"><div className="diff-empty">(trống)</div></div>;
  const kind = (line: string) => (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') ? 'meta'
    : line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : '');
  return <div className="diff" role="region" aria-label="Diff">{text.split('\n').map((line, i) => <span key={i} className={`diff-line ${kind(line)}`}>{line || ' '}</span>)}</div>;
}

export type ThemePref = 'system' | 'light' | 'dark';
const THEME_KEY = 'aidept-theme';
/** Light unless the person chose otherwise; "system" (follow the OS) is remembered like the other two. */
export function readTheme(): ThemePref {
  try { const v = localStorage.getItem(THEME_KEY); if (v === 'light' || v === 'dark' || v === 'system') return v; } catch { /* storage can be unavailable */ }
  return 'light';
}
export function applyTheme(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', pref);
  try { localStorage.setItem(THEME_KEY, pref); } catch { /* ignore */ }
}
/** Light by default; Dark and System (follow the OS) are choices remembered in this browser. */
export function ThemeSwitch() {
  const [pref, setPref] = useState<ThemePref>(readTheme);
  useEffect(() => { applyTheme(pref); }, [pref]);
  const options: [ThemePref, IconName, string][] = [['light', 'sun', 'Sáng'], ['system', 'laptop', 'Theo hệ điều hành'], ['dark', 'moon', 'Tối']];
  return <div className="theme-switch" role="group" aria-label="Giao diện">{options.map(([value, icon, label]) =>
    <button key={value} aria-pressed={pref === value} aria-label={label} title={label} onClick={() => setPref(value)}><Icon name={icon} size={14}/></button>)}</div>;
}

export const money = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 3 }).format(value);
export const count = (value: number) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
export function duration(ms: number) { const seconds = Math.max(0, Math.floor(ms / 1000)); return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`; }
export function dateTime(value: string) { return new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }
/** "5 phút trước" style relative time from an ISO timestamp. */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s trước`;
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
  if (s < 86_400) return `${Math.floor(s / 3600)} giờ trước`;
  return `${Math.floor(s / 86_400)} ngày trước`;
}
