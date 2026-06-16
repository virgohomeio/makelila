import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import styles from './NavCard.module.css';

type CountTone = 'default' | 'alert' | 'warn';

interface CommonProps {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  iconBg?: string;
  count?: number | string;
  countTone?: CountTone;
}

// NavCard is polymorphic: pass `to` for a router Link (used by MobileHome
// module cards) OR pass `onClick` for an in-page button (used by tab cards
// inside modules where the active tab is local state, not a route).
type NavCardProps =
  | (CommonProps & { to: string; onClick?: never })
  | (CommonProps & { onClick: () => void; to?: never });

export function NavCard(props: NavCardProps) {
  const { title, subtitle, icon, iconBg, count, countTone = 'default' } = props;
  const pillClass =
    countTone === 'alert' ? `${styles.countPill} ${styles.alert}` :
    countTone === 'warn'  ? `${styles.countPill} ${styles.warn}`  :
                            styles.countPill;
  const body = (
    <>
      {icon && (
        <div className={styles.icon} style={iconBg ? { background: iconBg } : undefined}>
          {icon}
        </div>
      )}
      <div className={styles.body}>
        <div className={styles.title}>{title}</div>
        {subtitle && <div className={styles.subtitle}>{subtitle}</div>}
      </div>
      <div className={styles.right}>
        {count !== undefined && count !== null && count !== '' && (
          <span className={pillClass}>{count}</span>
        )}
        <span className={styles.chevron}>›</span>
      </div>
    </>
  );
  if ('to' in props && props.to) {
    return <Link to={props.to} className={styles.card}>{body}</Link>;
  }
  return (
    <button type="button" onClick={props.onClick} className={styles.card}>
      {body}
    </button>
  );
}

export function NavGroupLabel({ children }: { children: ReactNode }) {
  return <div className={styles.groupLabel}>{children}</div>;
}
