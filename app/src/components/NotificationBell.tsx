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
        <span aria-hidden>🔔</span>
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
