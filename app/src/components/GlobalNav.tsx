import { Fragment } from 'react';
import { Link, NavLink } from 'react-router-dom';
import styles from './GlobalNav.module.css';
import { NotificationBell } from './NotificationBell';
import { UserBadge } from './UserBadge';
import { useAuth } from '../lib/auth';
import { canView, canAccessHiringModule } from '../lib/permissions';
import { useIsAssignedInterviewer } from '../lib/hiring';

// Ordered as an order's life, then the records that outlive it, then the
// company. `startsGroup` draws the seam. The previous order was arbitrary —
// Team and Marketing led, Products trailed, and Stock sat between Shipping
// and Service — so the strip read as twelve equal items rather than three
// groups of four. Same twelve entries, same labels; only the order and the
// two hairlines are new.
const MODULES = [
  // An order, start to finish. Shipping is no longer here: it was folded into
  // Fulfillment on 2026-08-28, where booking and tracking sit beside the queue
  // that produces the parcels. Stock moved up behind Fulfillment because it is
  // what Fulfillment draws from — you check the shelf, then you check stock.
  { path: '/order-review',  label: 'Sales' },
  { path: '/fulfillment',   label: 'Fulfillment' },
  { path: '/stock',         label: 'Stock' },
  { path: '/service',       label: 'Service' },
  // The records it touches, which outlive it.
  { path: '/customers',     label: 'Customers', startsGroup: true },
  { path: '/products',      label: 'Products' },
  { path: '/lovely',        label: 'Lovely' },
  // The company around it.
  { path: '/marketing',     label: 'Marketing', startsGroup: true },
  { path: '/finance',       label: 'Finance' },
  { path: '/team',          label: 'Team' },
  { path: '/hiring',        label: 'Hiring' },
];

const MARKETING_ROLES = ['pedrum@virgohome.io', 'huayi@virgohome.io', 'george@virgohome.io', 'yueli@virgohome.io', 'support@virgohome.io'];

export function GlobalNav() {
  const { user, role } = useAuth();
  const userEmail = user?.email ?? '';
  const { isAssigned: isAssignedInterviewer } = useIsAssignedInterviewer();

  const visibleModules = MODULES.filter(m => {
    if (m.path === '/marketing') return MARKETING_ROLES.includes(userEmail.toLowerCase());
    if (m.path === '/finance') return canView(role, 'finance');
    if (m.path === '/hiring') return canAccessHiringModule(role, isAssignedInterviewer);
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
      {visibleModules.map((m, i) => (
        <Fragment key={m.path}>
          {/* Suppressed on the first visible item: permissions can hide the
              module a group starts with (Marketing and Finance are both
              role-gated), and a seam with nothing before it is just a rule
              floating against the brand divider. */}
          {m.startsGroup && i > 0 && <span className={styles.groupBreak} aria-hidden="true" />}
          <NavLink
            to={m.path}
            className={({ isActive }) =>
              isActive ? `${styles.item} ${styles.active}` : styles.item
            }
          >
            {m.label}
          </NavLink>
        </Fragment>
      ))}
      <div className={styles.spacer} />
      <div className={styles.tray}>
        <NotificationBell />
        <UserBadge />
      </div>
    </nav>
  );
}
