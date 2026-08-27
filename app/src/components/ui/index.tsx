/* The shared control vocabulary — see primitives.module.css for the design
   rules these encode, and why they exist at all.

   Deliberately six components and no more. Each one replaces a control that
   had been re-implemented in most of the app's eighteen modules; anything
   that is genuinely used once still belongs in its own module. */
import { Fragment } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import s from './primitives.module.css';

const cx = (...parts: (string | false | null | undefined)[]) =>
  parts.filter(Boolean).join(' ');

/* ── Tabs ──────────────────────────────────────────────────────────────── */

export type TabItem = {
  key: string;
  label: string;
  /** Rendered beside the label in the data face. Omit rather than passing 0
   *  when a count is not meaningful for this tab. */
  count?: number;
  /** Draws a hairline before this tab, for a genuine group break in the row.
   *  Fulfillment carried a literal "|" in its markup to do this. */
  startsGroup?: boolean;
};

export function Tabs({
  items, active, onChange, ariaLabel,
}: {
  items: TabItem[];
  active: string;
  onChange: (key: string) => void;
  ariaLabel: string;
}) {
  return (
    <div className={s.tabs} role="tablist" aria-label={ariaLabel}>
      {items.map((t) => (
        <Fragment key={t.key}>
          {t.startsGroup && <span className={s.tabGap} aria-hidden="true" />}
          <button
            type="button"
            role="tab"
            aria-selected={active === t.key}
            className={cx(s.tab, active === t.key && s.tabActive)}
            onClick={() => onChange(t.key)}
          >
            {t.label}
            {t.count !== undefined && <span className={s.tabCount}>{t.count}</span>}
          </button>
        </Fragment>
      ))}
    </div>
  );
}

/* ── Filter chips ──────────────────────────────────────────────────────── */

export function Chip({
  label, count, active, onClick,
}: {
  label: string;
  count?: number;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={!!active}
      className={cx(s.chip, active && s.chipActive)}
      onClick={onClick}
    >
      {label}
      {count !== undefined && (
        <span className={cx(s.chipCount, count === 0 && !active && s.chipZero)}>{count}</span>
      )}
    </button>
  );
}

export function ChipRow({ children }: { children: ReactNode }) {
  return <div className={s.chipRow}>{children}</div>;
}

/* ── Button ────────────────────────────────────────────────────────────── */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** `danger` is an outline, not a fill — a filled danger red is
   *  indistinguishable from the primary button's hover state. See the
   *  --color-error note in tokens.css. */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  small?: boolean;
};

export function Button({
  variant = 'secondary', small, className, type = 'button', ...rest
}: ButtonProps) {
  const variantClass = {
    primary: s.btnPrimary,
    secondary: s.btnSecondary,
    ghost: s.btnGhost,
    danger: s.btnDanger,
  }[variant];
  return (
    <button
      type={type}
      className={cx(s.btn, variantClass, small && s.btnSmall, className)}
      {...rest}
    />
  );
}

/* ── Page header ───────────────────────────────────────────────────────── */

export function PageHeader({
  title, meta, actions,
}: {
  title: ReactNode;
  /** What is in this screen right now. Wrap figures in <strong> so they pick
   *  up the data face and stop jittering as they update. */
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className={s.pageHeader}>
      <div>
        <h1 className={s.pageTitle}>{title}</h1>
        {meta && <div className={s.pageMeta}>{meta}</div>}
      </div>
      {actions && <div className={s.pageActions}>{actions}</div>}
    </header>
  );
}

/* ── Empty state ───────────────────────────────────────────────────────── */

export function EmptyState({
  title, body, action,
}: {
  /** What is true, in the operator's words. "Nothing queued", not "No data". */
  title: string;
  /** Why it is empty, or what fills it. One line. */
  body?: string;
  /** The way out. An empty screen with no action is a dead end. */
  action?: ReactNode;
}) {
  return (
    <div className={s.empty}>
      <span className={s.emptyMark} aria-hidden="true">
        <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.25">
          <rect x="1.5" y="3.5" width="12" height="9" rx="1.5" />
          <path d="M1.5 6.5h12" />
        </svg>
      </span>
      <div className={s.emptyTitle}>{title}</div>
      {body && <p className={s.emptyBody}>{body}</p>}
      {action && <div className={s.emptyAction}>{action}</div>}
    </div>
  );
}

/* ── Stat tiles ────────────────────────────────────────────────────────── */

export function StatRow({ children }: { children: ReactNode }) {
  return <div className={s.statRow}>{children}</div>;
}

export function Stat({
  label, value, hint, urgent,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  /** Reserve this for a figure that means someone has to act. A tile reading
   *  zero is good news and is dimmed, not accented. */
  urgent?: boolean;
}) {
  const isZero = value === 0 || value === '0' || value === '—';
  return (
    <div className={s.stat}>
      <div className={s.statLabel}>{label}</div>
      <div className={cx(s.statValue, isZero && s.statZero, urgent && !isZero && s.statUrgent)}>
        {value}
      </div>
      {hint && <div className={s.statHint}>{hint}</div>}
    </div>
  );
}
