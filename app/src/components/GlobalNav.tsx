import { NavLink } from 'react-router-dom';
import styles from './GlobalNav.module.css';
import { UserBadge } from './UserBadge';

const MODULES = [
  { path: '/order-review',  label: 'Order Review' },
  { path: '/fulfillment',   label: 'Fulfillment' },
  { path: '/post-shipment', label: 'Post-Shipment' },
  { path: '/stock',         label: 'Stock' },
  { path: '/activity-log',  label: 'Activity Log' },
];

export function GlobalNav() {
  return (
    <nav className={styles.nav}>
      <div className={styles.brand}>MAKE LILA</div>
      {MODULES.map(m => (
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
