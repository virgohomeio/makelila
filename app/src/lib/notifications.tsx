import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { MachineStatus } from './dashboard';

// ── Fleet notifications ─────────────────────────────────────────────────────
//
// Phase 1 (backlog: notification bell): surface every customer machine whose
// live status is anything other than OK. The Fleet tab (Customers → Fleet /
// Dashboard) is the *producer* — it already computes a status per machine, so
// it publishes the non-OK ones here via setFleetNotifications(). The bell in
// GlobalNav is the *consumer*. This context lives in AppShell (above both the
// nav and the route Outlet), so notifications persist as the operator moves
// between modules after they've visited the Fleet tab once.
//
// "Read" state is tracked per (serial + status) so the red badge clears once
// the operator has looked, but a machine that recovers and later regresses
// (or flips to a different tag) re-alerts.

export type FleetNotification = {
  serial: string;
  customerName: string;
  status: MachineStatus;
};

/** Stable identity for a notification — same machine + same tag = same alert. */
export function notificationKey(n: FleetNotification): string {
  return `${n.serial}:${n.status}`;
}

type NotificationsValue = {
  notifications: FleetNotification[];
  unreadCount: number;
  isUnread: (n: FleetNotification) => boolean;
  /** Called by the Fleet view to replace the current fleet-sourced alerts. */
  setFleetNotifications: (list: FleetNotification[]) => void;
  /** Mark every currently-shown alert as seen (clears the badge). */
  markAllRead: () => void;
};

const NotificationsContext = createContext<NotificationsValue | null>(null);

const SEEN_KEY = 'makelila.notifications.seen';

function loadSeen(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function saveSeen(seen: Set<string>) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen]));
  } catch {
    /* ignore quota / private-mode write errors */
  }
}

function sameList(a: FleetNotification[], b: FleetNotification[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].serial !== b[i].serial || a[i].status !== b[i].status || a[i].customerName !== b[i].customerName) {
      return false;
    }
  }
  return true;
}

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<FleetNotification[]>([]);
  const [seen, setSeen] = useState<Set<string>>(() => loadSeen());

  const setFleetNotifications = useCallback((list: FleetNotification[]) => {
    setNotifications((prev) => (sameList(prev, list) ? prev : list));
    // Drop seen keys that are no longer active so a resolved-then-recurring
    // issue re-alerts, and the stored set stays bounded to the live fleet.
    setSeen((prevSeen) => {
      if (prevSeen.size === 0) return prevSeen;
      const active = new Set(list.map(notificationKey));
      const next = new Set<string>();
      for (const k of prevSeen) if (active.has(k)) next.add(k);
      if (next.size === prevSeen.size) return prevSeen;
      saveSeen(next);
      return next;
    });
  }, []);

  const markAllRead = useCallback(() => {
    setSeen((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const n of notifications) {
        const k = notificationKey(n);
        if (!next.has(k)) { next.add(k); changed = true; }
      }
      if (!changed) return prev;
      saveSeen(next);
      return next;
    });
  }, [notifications]);

  const isUnread = useCallback(
    (n: FleetNotification) => !seen.has(notificationKey(n)),
    [seen],
  );

  const unreadCount = useMemo(
    () => notifications.reduce((acc, n) => (seen.has(notificationKey(n)) ? acc : acc + 1), 0),
    [notifications, seen],
  );

  const value = useMemo<NotificationsValue>(
    () => ({ notifications, unreadCount, isUnread, setFleetNotifications, markAllRead }),
    [notifications, unreadCount, isUnread, setFleetNotifications, markAllRead],
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications(): NotificationsValue {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error('useNotifications must be used within a NotificationsProvider');
  return ctx;
}
