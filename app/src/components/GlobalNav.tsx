import { Link, NavLink } from 'react-router-dom';
import styles from './GlobalNav.module.css';
import { UserBadge } from './UserBadge';
import { useAuth } from '../lib/auth';
import { canView } from '../lib/permissions';

const MODULES = [
  { path: '/team',          label: 'Team' },
  { path: '/marketing',     label: 'Marketing' },
  { path: '/order-review',  label: 'Sales' },
  { path: '/fulfillment',   label: 'Fulfillment' },
  { path: '/shipping',      label: 'Shipping' },
  { path: '/stock',         label: 'Stock' },
  { path: '/service',       label: 'Service' },
  { path: '/customers',     label: 'Customers' },
  { path: '/finance',       label: 'Finance' },
];

const MARKETING_ROLES = ['pedrum@virgohome.io', 'huayi@virgohome.io', 'george@virgohome.io'];

export function GlobalNav() {
  const { user, role } = useAuth();
  const userEmail = user?.email ?? '';

  const visibleModules = MODULES.filter(m => {
    if (m.path === '/marketing') return MARKETING_ROLES.includes(userEmail.toLowerCase());
    if (m.path === '/finance') return canView(role, 'finance');
    return true;
  });

  return (
    <nav className={styles.nav}>
      <Link to="/" className={styles.brand} aria-label="Home">
        <img
          src={`${import.meta.env.BASE_URL}vcycene-logo-square.png`}
          alt="VCycene"
          className={styles.brandLogo}
        />
        <span className={styles.brandWordmark}>makelila</span>
      </Link>
      {visibleModules.map(m => (
        <NavLink
          key={m.path}
          to={m.path}
          className={({ isActive }) =>
            isActive ? `${styles.item} ${styles.active}` : styles.item
          }
        >
          {m.label}
        </NavLink>
      ))}
      <div className={styles.spacer} />
      <UserBadge />
    </nav>
  );
}
