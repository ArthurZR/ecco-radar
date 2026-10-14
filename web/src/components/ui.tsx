import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { STATUS_LABEL, STATUS_SHORT, type Status } from '../lib/types';

export function PageHead({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  useEffect(() => {
    document.title = `${title} · eccö RADAR`;
  }, [title]);
  return (
    <div className="pagehead">
      <h1>{title}</h1>
      {sub ? <span className="sub">{sub}</span> : null}
      <div className="grow" />
      {children}
    </div>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return <div className="loading" role="status">{label}</div>;
}

export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  if (!error) return null;
  const msg = error instanceof ApiError ? error.message : error instanceof Error ? error.message : String(error);
  return (
    <div className="notice danger row between" role="alert">
      <span>{msg}</span>
      {retry ? <button className="sm" onClick={retry}>Retry</button> : null}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {children}
    </div>
  );
}

const STATUS_TONE: Partial<Record<Status, string>> = {
  approved_consideration: 'green', reviewed: 'green', approved_publication: 'solid', manually_published: 'solid', rejected: 'danger', caption_draft: 'warn',
};

export function StatusBadge({ status, long }: { status: Status; long?: boolean }) {
  return (
    <span className={`badge ${STATUS_TONE[status] ?? ''}`} title={STATUS_LABEL[status]}>
      {long ? STATUS_LABEL[status] : STATUS_SHORT[status]}
    </span>
  );
}

export function RefLink({ label, children }: { label: string; children?: ReactNode }) {
  return <Link className="refid" to={`/ref/${label.replace('#', '')}`}>{children ?? label}</Link>;
}

/**
 * Images are loaded straight from the source with no referrer. If that fails and RADAR holds a
 * permitted local copy, the copy is shown instead; then RADAR's pass-through; otherwise a labelled box.
 */
export function Thumb({ src, fallback, refNumber, alt, className }: { src: string | null; fallback?: string | null; refNumber?: number; alt: string; className?: string }) {
  const [attempt, setAttempt] = useState(0);
  // Last resort: RADAR fetches the source's own preview for the browser, without keeping it.
  const proxy = src && refNumber ? `/api/references/${refNumber}/preview-proxy` : null;
  const sources = [src, fallback, proxy].filter((x): x is string => !!x);
  const current = sources[attempt];
  if (!current) return <div className={`noimg ${className ?? ''}`}>{sources.length ? 'Image unavailable' : 'No preview'}</div>;
  return <img key={current} src={current} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setAttempt((a) => a + 1)} className={className} />;
}

/**
 * A four-digit year field. It keeps what the person types (a half-typed "19" stays on screen) and
 * reports a year only once all four digits are there; clearing the field reports undefined.
 */
export function YearInput({ value, onChange, label, placeholder, width = 80 }: {
  value: number | string | undefined | null;
  onChange: (year: number | undefined) => void;
  label?: string;
  placeholder?: string;
  width?: number;
}) {
  const external = value === undefined || value === null || value === '' ? '' : String(value);
  const [text, setText] = useState(external);
  useEffect(() => {
    setText((t) => (/^\d{4}$/.test(t) || t === '' ? external : t));
  }, [external]);
  const invalid = text !== '' && !/^\d{4}$/.test(text);
  return (
    <input
      aria-label={label}
      aria-invalid={invalid || undefined}
      title={invalid ? 'Type a four-digit year, e.g. 1999' : undefined}
      inputMode="numeric"
      maxLength={4}
      placeholder={placeholder ?? 'e.g. 1999'}
      style={{ width }}
      value={text}
      onChange={(e) => {
        const t = e.target.value.replace(/\D/g, '').slice(0, 4);
        setText(t);
        if (t === '') onChange(undefined);
        else if (t.length === 4) onChange(Number(t));
      }}
    />
  );
}

export function Dialog({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, select, textarea, button:not([data-close])');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header>
          <h2>{title}</h2>
          <button className="ghost sm" data-close onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="body">{children}</div>
        {footer ? <footer>{footer}</footer> : null}
      </div>
    </div>
  );
}

/* ---------- toasts ---------- */
interface Toast { id: number; text: string; error?: boolean; action?: { label: string; run: () => void } }
const ToastCtx = createContext<(t: Omit<Toast, 'id'>) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    window.clearTimeout(timer.current);
    setToast({ ...t, id: Date.now() });
    timer.current = window.setTimeout(() => setToast(null), t.action ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {toast ? (
        <div className={`toast ${toast.error ? 'error' : ''}`} role="status" aria-live="polite">
          <span>{toast.text}</span>
          {toast.action ? (
            <button className="sm" onClick={() => { toast.action!.run(); setToast(null); }}>{toast.action.label}</button>
          ) : null}
        </div>
      ) : null}
    </ToastCtx.Provider>
  );
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function HBar({ value, max = 1, green }: { value: number | null; max?: number; green?: boolean }) {
  const pct = value === null ? 0 : Math.max(0, Math.min(1, value / max)) * 100;
  return <div className={`hbar ${green ? 'green' : ''}`} aria-hidden><i style={{ width: `${pct}%` }} /></div>;
}
