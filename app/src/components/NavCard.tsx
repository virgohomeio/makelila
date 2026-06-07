import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import styles from './NavCard.module.css';

type CountTone = 'default' | 'alert' | 'warn';

interface NavCardProps {
  to: string;
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  iconBg?: string;
  count?: number | string;
  countTone?: CountTone;
}

export function NavCard({
  to,
  title,
  subtitle,
  icon,
  iconBg,
  count,
  countTone = 'default',
}: NavCardProps) {
  const pillClass =
    countTone === 'alert' ? `${styles.countPill} ${styles.alert}` :
    countTone === 'warn'  ? `${styles.countPill} ${styles.warn}`  :
                            styles.countPill;
  return (
    <Link to={to} className={styles.card}>
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
    </Link>
  );
}

export function NavGroupLabel({ children }: { children: ReactNode }) {
  return <div className={styles.groupLabel}>{children}</div>;
}
