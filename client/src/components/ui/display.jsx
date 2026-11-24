import { Link } from 'react-router-dom';
import { X, AlertTriangle, Info, CheckCircle2, XCircle, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { Button } from './controls';

/* ------------------------------------------------------------------ */
/* Surfaces                                                            */
/* ------------------------------------------------------------------ */

/** Card — a flat panel: 1px hairline, 8px radius, no shadow. Prefer <Panel>. */
export function Card({ className, children, ...rest }) {
  return (
    <div className={clsx('rounded-lg border border-line bg-panel', className)} {...rest}>
      {children}
    </div>
  );
}

/**
 * Panel — a titled section of a page. Header row: title (+ optional count and
 * description) on the left, actions on the right; then the body. `flush`
 * removes body padding (tables, lists that draw their own rows).
 */
export function Panel({ title, description, count, actions, flush = false, as: Tag = 'section', headingLevel = 2, className, bodyClassName, children, ...rest }) {
  const H = `h${headingLevel}`;
  return (
    <Tag className={clsx('min-w-0 rounded-lg border border-line bg-panel', className)} {...rest}>
      {(title || actions) && (
        <div className="flex min-h-10 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line px-4 py-2">
          <div className="min-w-0">
            {title && (
              <H className="flex items-baseline gap-2 text-sm font-medium text-fg">
                {title}
                {count != null && <span className="font-mono text-xs font-normal text-subtle">{count}</span>}
              </H>
            )}
            {description && <p className="text-xs text-subtle">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </div>
      )}
      <div className={clsx(!flush && 'p-4', bodyClassName)}>{children}</div>
    </Tag>
  );
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const TONE_OF = {
  connected: 'good',
  online: 'good',
  running: 'good',
  ok: 'good',
  healthy: 'good',
  good: 'good',
  success: 'good',
  live: 'good',
  connecting: 'warn',
  reconnecting: 'warn',
  degraded: 'warn',
  warning: 'warn',
  warn: 'warn',
  stale: 'warn',
  pending: 'warn',
  overdue: 'warn',
  error: 'bad',
  failed: 'bad',
  fault: 'bad',
  bad: 'bad',
  dead: 'bad',
  info: 'info'
};

/** Map a status word to a tone: good | warn | bad | info | neutral. */
export const toneOf = (status) => TONE_OF[String(status || '').toLowerCase()] || 'neutral';

const DOT = { good: 'bg-good', warn: 'bg-warn', bad: 'bg-bad', info: 'bg-info', neutral: 'bg-control-off' };
const TONE_TEXT = { good: 'text-fg', warn: 'text-fg', bad: 'text-bad', info: 'text-fg', neutral: 'text-muted' };

/** StatusDot — a 8px state dot. Decorative: pair it with text (or use StatusText). */
export function StatusDot({ status, tone, size = 8, className }) {
  const t = tone || toneOf(status);
  return (
    <span
      aria-hidden="true"
      className={clsx('inline-block shrink-0 rounded-full', DOT[t] || DOT.neutral, className)}
      style={{ width: size, height: size }}
    />
  );
}

/** StatusText — dot + word. The standard way to show connection/device state. */
export function StatusText({ status, tone, children, className }) {
  const t = tone || toneOf(status);
  return (
    <span className={clsx('inline-flex items-center gap-1.5 whitespace-nowrap text-sm', TONE_TEXT[t], className)}>
      <StatusDot tone={t} />
      {children ?? status}
    </span>
  );
}

/**
 * Badge — a small quiet label (protocol, type, count). With `status` it renders
 * as StatusText (dot + word), the old coloured pill is gone. `tone` tints the
 * text only: good | warn | bad | info | accent.
 */
export function Badge({ status, tone, children, className }) {
  if (status) {
    return (
      <StatusText status={status} className={clsx('text-xs', className)}>
        {children || status}
      </StatusText>
    );
  }
  const toneText = { good: 'text-good', warn: 'text-warn', bad: 'text-bad', info: 'text-info', accent: 'text-accent-text' }[tone] || 'text-muted';
  return (
    <span className={clsx('inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded border border-line bg-raised px-1.5 text-xs font-medium', toneText, className)}>
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Data display                                                        */
/* ------------------------------------------------------------------ */

/**
 * Stat — one number with its label. No icon tile. Optional unit, secondary
 * line (`sub`), state tone (colours a dot before the label) and link target.
 */
export function Stat({ label, value, unit, sub, tone, to, className, valueClassName, 'data-testid': testId }) {
  const body = (
    <>
      <p className="flex items-center gap-1.5 text-xs text-muted">
        {tone && <StatusDot tone={tone} size={6} />}
        {label}
      </p>
      <p className="mt-1 flex items-baseline gap-1">
        <span className={clsx('text-xl font-medium tabular-nums tracking-tight text-fg', valueClassName)} data-testid={testId}>
          {value}
        </span>
        {unit && <span className="text-sm text-subtle">{unit}</span>}
      </p>
      {sub && <p className="mt-0.5 truncate text-xs text-subtle">{sub}</p>}
    </>
  );
  const cls = clsx('block min-w-0 bg-panel px-4 py-3', to && 'transition-colors duration-150 hover:bg-raised', className);
  return to ? (
    <Link to={to} className={cls}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** StatGroup — stats in one bordered strip with hairline dividers (pass grid-cols-* in className). */
export function StatGroup({ children, className, label }) {
  return (
    <section
      aria-label={label}
      className={clsx('grid overflow-hidden rounded-lg border border-line bg-panel [&>*]:-ml-px [&>*]:-mt-px [&>*]:border-l [&>*]:border-t [&>*]:border-line', className)}
    >
      {children}
    </section>
  );
}

/**
 * Meter — a thin horizontal gauge (poll cycle vs interval, queue fill, disk).
 * `warnAt`/`badAt` are fractions of max that switch the fill tone.
 */
export function Meter({ value, max = 1, label, warnAt, badAt, tone, className }) {
  const frac = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const t = tone || (badAt != null && frac >= badAt ? 'bad' : warnAt != null && frac >= warnAt ? 'warn' : 'accent');
  const fill = { accent: 'bg-accent', good: 'bg-good', warn: 'bg-warn', bad: 'bg-bad', neutral: 'bg-control-off' }[t];
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} className={clsx('h-1 w-full overflow-hidden rounded-full bg-raised', className)}>
      <div className={clsx('h-full rounded-full transition-[width] duration-150', fill)} style={{ width: `${frac * 100}%` }} />
    </div>
  );
}

/** KeyValue — a definition list. items: [[label, value], ...] or [{ label, value }]. */
export function KeyValue({ items, columns = 1, className }) {
  return (
    <dl className={clsx('grid gap-x-6 gap-y-2 text-sm', columns === 2 && 'sm:grid-cols-2', columns === 3 && 'sm:grid-cols-3', className)}>
      {items.filter(Boolean).map((it) => {
        const [k, v] = Array.isArray(it) ? it : [it.label, it.value];
        return (
          <div key={String(k)} className="flex min-w-0 items-baseline justify-between gap-3 border-b border-line pb-2 last:border-b-0">
            <dt className="shrink-0 text-muted">{k}</dt>
            <dd className="min-w-0 truncate text-right text-fg">{v}</dd>
          </div>
        );
      })}
    </dl>
  );
}

/** Kbd — a keyboard key. */
export function Kbd({ children, className }) {
  return <kbd className={clsx('inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-line-strong px-1 font-mono text-2xs text-subtle', className)}>{children}</kbd>;
}

/** Mono — an identifier, address, topic or value in the data face. */
export function Mono({ children, className, title }) {
  return (
    <span className={clsx('font-mono text-xs', className)} title={title}>
      {children}
    </span>
  );
}

/**
 * Path — a topic / asset / node path that truncates its START, never the leaf:
 * "…/line1/filler/pressure". Full value in the tooltip. Use inside a min-w-0 parent.
 */
export function Path({ value, separator = '/', className }) {
  const str = String(value ?? '');
  const i = str.lastIndexOf(separator);
  const head = i > 0 ? str.slice(0, i + 1) : '';
  const leaf = i > 0 ? str.slice(i + 1) : str;
  return (
    <span className={clsx('flex min-w-0 font-mono text-xs', className)} title={str}>
      {head && <span className="min-w-0 truncate text-subtle">{head}</span>}
      <span className="shrink-0 truncate">{leaf}</span>
    </span>
  );
}

/** Code — inline code on a raised chip. */
export function Code({ children, className }) {
  return <code className={clsx('rounded border border-line bg-raised px-1 py-px font-mono text-xs text-fg', className)}>{children}</code>;
}

/** Compact relative time: "4 s ago", "12 min ago", "3 h ago", then a date. */
export function relativeTime(ts, now = Date.now()) {
  const t = typeof ts === 'number' ? ts : new Date(ts).getTime();
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(t).toLocaleDateString();
}

/** Timestamp — relative time with the absolute time as tooltip and machine value. */
export function Timestamp({ value, className }) {
  const d = new Date(value);
  const valid = Number.isFinite(d.getTime());
  return (
    <time dateTime={valid ? d.toISOString() : undefined} title={valid ? d.toLocaleString() : undefined} className={clsx('whitespace-nowrap tabular-nums', className)}>
      {relativeTime(value)}
    </time>
  );
}

/* ------------------------------------------------------------------ */
/* Feedback                                                            */
/* ------------------------------------------------------------------ */

/** EmptyState — text first, one action. The icon (optional) is small and quiet. */
export function EmptyState({ icon: Icon, title, hint, action, className }) {
  return (
    <div className={clsx('flex h-full min-h-[10rem] flex-col items-center justify-center gap-2 px-6 py-8 text-center', className)}>
      {Icon && <Icon size={20} aria-hidden="true" className="mb-1 text-faint" />}
      <p className="text-sm font-medium text-fg">{title}</p>
      {hint && <p className="mx-auto max-w-md text-sm text-muted">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

const BANNER_STYLES = {
  info: { rule: 'border-l-info', icon: Info, iconClass: 'text-info', tint: 'bg-info/[0.06]' },
  success: { rule: 'border-l-good', icon: CheckCircle2, iconClass: 'text-good', tint: 'bg-good/[0.06]' },
  warn: { rule: 'border-l-warn', icon: AlertTriangle, iconClass: 'text-warn', tint: 'bg-warn/[0.06]' },
  error: { rule: 'border-l-bad', icon: XCircle, iconClass: 'text-bad', tint: 'bg-bad/[0.06]' }
};

/**
 * Banner — an inline alert: hairline box with a 2px state rule on the left.
 * Errors use role="alert"; the rest role="status". `onRetry` adds Retry,
 * `onDismiss` a close button, `action` any extra control.
 */
export function Banner({ variant = 'info', title, children, onRetry, retryLabel = 'Retry', onDismiss, action, className }) {
  const v = BANNER_STYLES[variant] || BANNER_STYLES.info;
  const Icon = v.icon;
  return (
    <div
      role={variant === 'error' ? 'alert' : 'status'}
      className={clsx('flex flex-wrap items-start gap-2.5 rounded-md border border-l-2 border-line px-3 py-2 text-sm text-fg', v.rule, v.tint, className)}
    >
      <Icon size={16} aria-hidden="true" className={clsx('mt-0.5 shrink-0', v.iconClass)} />
      <div className="min-w-0 flex-1 basis-48">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={clsx('text-sm text-muted', title && 'mt-0.5')}>{children}</div>}
      </div>
      {(action || onRetry || onDismiss) && (
        <div className="flex shrink-0 items-center gap-1.5">
          {action}
          {onRetry && (
            <Button size="sm" variant="secondary" onClick={onRetry}>
              <RefreshCw size={12} aria-hidden="true" /> {retryLabel}
            </Button>
          )}
          {onDismiss && (
            <button type="button" onClick={onDismiss} aria-label="Dismiss message" className="grid h-7 w-7 place-items-center rounded-md text-muted transition-colors hover:bg-raised hover:text-fg">
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Skeleton — a pulsing placeholder block. Decorative; wrap in LoadingState for semantics. */
export function Skeleton({ className }) {
  return <div aria-hidden="true" className={clsx('animate-pulse rounded bg-raised', className || 'h-4 w-full')} />;
}

/** LoadingState — a skeleton list placeholder announced as "Loading <label>". */
export function LoadingState({ label = 'content', rows = 4, className }) {
  return (
    <div role="status" aria-busy="true" className={clsx('overflow-hidden rounded-lg border border-line bg-panel', className)}>
      <span className="sr-only">Loading {label}…</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4 border-t border-line px-4 py-3 first:border-t-0">
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
          <Skeleton className="hidden h-3 w-16 sm:block" />
        </div>
      ))}
    </div>
  );
}

/** Full-page fallback for lazy routes. */
export function PageSkeleton() {
  return (
    <div className="flex h-full flex-col" role="status" aria-busy="true">
      <span className="sr-only">Loading page…</span>
      <div className="flex h-14 items-center border-b border-line px-4 sm:px-6">
        <Skeleton className="h-5 w-40" />
      </div>
      <div className="flex-1 space-y-3 overflow-hidden p-4 sm:p-6">
        <Skeleton className="h-20 w-full rounded-lg" />
        <Skeleton className="h-48 w-full rounded-lg" />
      </div>
    </div>
  );
}
