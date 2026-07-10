import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useNotifications, notificationKey } from '../lib/notifications';
import { STATUS_COLORS, STATUS_DESCRIPTIONS } from '../lib/dashboard';
import styles from './NotificationBell.module.css';

export function NotificationBell() {
  const { notifications, unreadCount, isUnread, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      // Opening the panel counts as seeing the current alerts.
      if (next) markAllRead();
      return next;
    });
  };

  const goTo = (serial: string) => {
    setOpen(false);
    navigate(`/customers?tab=fleet&serial=${encodeURIComponent(serial)}`);
  };

  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={`${styles.bell} ${open ? styles.bellActive : ''}`}
        onClick={toggle}
        aria-label={`Notifications${unreadCount ? ` (${unreadCount} unread)` : ''}`}
        title="Machine alerts"
      >
        <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M12 2a1.6 1.6 0 0 1 1.6 1.6v.55a6 6 0 0 1 4.4 5.79v2.86l1.46 2.2A1 1 0 0 1 18.62 16.5H5.38a1 1 0 0 1-.84-1.5L6 12.8V9.94a6 6 0 0 1 4.4-5.79V3.6A1.6 1.6 0 0 1 12 2Z" />
          <path d="M9.5 18a2.5 2.5 0 0 0 5 0h-5Z" />
        </svg>
        {unreadCount > 0 && (
          <span className={styles.badge}>{unreadCount > 99 ? '99+' : unreadCount}</span>
        )}
      </button>

      {open && (
        <>
          <div className={styles.backdrop} onClick={() => setOpen(false)} />
          <div className={styles.panel} role="menu">
            <div className={styles.panelHeader}>
              <span>Machine alerts</span>
              <span className={styles.panelHeaderCount}>
                {notifications.length} flagged
              </span>
            </div>

            {notifications.length === 0 ? (
              <div className={styles.empty}>
                No alerts — every customer machine is OK.
                <br />
                Open Customers → Fleet to refresh.
              </div>
            ) : (
              notifications.map((n) => (
                <button
                  key={notificationKey(n)}
                  type="button"
                  role="menuitem"
                  className={`${styles.item} ${isUnread(n) ? styles.itemUnread : ''}`}
                  onClick={() => goTo(n.serial)}
                  title={STATUS_DESCRIPTIONS[n.status]}
                >
                  <span
                    className={styles.dot}
                    style={{ background: STATUS_COLORS[n.status] }}
                  />
                  <span className={styles.itemBody}>
                    <span className={styles.itemName}>{n.customerName}</span>
                    <span className={styles.itemMeta}>{n.serial}</span>
                  </span>
                  <span
                    className={styles.statusPill}
                    style={{ background: STATUS_COLORS[n.status] }}
                  >
                    {n.status}
                  </span>
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
