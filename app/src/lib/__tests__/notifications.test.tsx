import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  NotificationsProvider,
  useNotifications,
  notificationKey,
  type FleetNotification,
} from '../notifications';

const wrapper = ({ children }: { children: ReactNode }) => (
  <NotificationsProvider>{children}</NotificationsProvider>
);

const n = (serial: string, status: FleetNotification['status'], customerName = serial): FleetNotification =>
  ({ serial, customerName, status });

describe('notifications', () => {
  beforeEach(() => localStorage.clear());

  it('keys a notification by serial + status', () => {
    expect(notificationKey(n('LL01', 'NOT_MIXING'))).toBe('LL01:NOT_MIXING');
  });

  it('counts every published alert as unread until seen', () => {
    const { result } = renderHook(() => useNotifications(), { wrapper });

    act(() => result.current.setFleetNotifications([n('A', 'DRY_SOIL'), n('B', 'OPEN_LID')]));
    expect(result.current.notifications).toHaveLength(2);
    expect(result.current.unreadCount).toBe(2);

    act(() => result.current.markAllRead());
    expect(result.current.unreadCount).toBe(0);
  });

  it('re-alerts when a resolved machine regresses to a new tag', () => {
    const { result } = renderHook(() => useNotifications(), { wrapper });

    act(() => result.current.setFleetNotifications([n('A', 'DRY_SOIL')]));
    act(() => result.current.markAllRead());
    expect(result.current.unreadCount).toBe(0);

    // A recovers (drops off the list) — seen state for it is pruned…
    act(() => result.current.setFleetNotifications([]));
    // …then the same machine flags a *different* tag: it's unread again.
    act(() => result.current.setFleetNotifications([n('A', 'SOAKED_SOIL')]));
    expect(result.current.unreadCount).toBe(1);
  });

  it('persists seen state across provider remounts', () => {
    const first = renderHook(() => useNotifications(), { wrapper });
    act(() => first.result.current.setFleetNotifications([n('A', 'DIAGNOSE')]));
    act(() => first.result.current.markAllRead());
    first.unmount();

    const second = renderHook(() => useNotifications(), { wrapper });
    act(() => second.result.current.setFleetNotifications([n('A', 'DIAGNOSE')]));
    expect(second.result.current.unreadCount).toBe(0);
  });
});
