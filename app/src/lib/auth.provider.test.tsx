import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import type { Session } from '@supabase/supabase-js';

// Controllable mock of the singleton client. We capture the
// onAuthStateChange callback so tests can drive auth events, let each test
// dictate what getSession() resolves to, and spy on signOut().
type AuthCb = (event: string, session: Session | null) => void;
const captured: { cb: AuthCb | null } = { cb: null };
const getSession = vi.fn();
const signOut = vi.fn();
const unsubscribe = vi.fn();

vi.mock('./supabase', () => ({
  supabase: {
    auth: {
      getSession: () => getSession(),
      onAuthStateChange: (cb: AuthCb) => {
        captured.cb = cb;
        return { data: { subscription: { unsubscribe } } };
      },
      signOut: () => signOut(),
    },
    // profiles fetch: from('profiles').select().eq().single() -> thenable
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: null }),
        }),
      }),
    }),
  },
}));

// Imported after the mock is registered.
const { AuthProvider, useAuth } = await import('./auth');

function Probe() {
  const { session, loading } = useAuth();
  return <div data-testid="state">{loading ? 'loading' : session ? 'in' : 'out'}</div>;
}

const sessionFor = (email: string | undefined): Session =>
  ({ user: { id: 'u1', email } } as unknown as Session);
const validSession = sessionFor('huayi@virgohome.io');

beforeEach(() => {
  captured.cb = null;
  getSession.mockReset();
  signOut.mockReset();
  unsubscribe.mockReset();
  // jsdom has no real alert(); the domain-reject path calls it.
  vi.stubGlobal('alert', vi.fn());
});

describe('AuthProvider session resilience', () => {
  it('keeps the operator signed in when a spurious null auth event fires (session still in storage)', async () => {
    getSession.mockResolvedValue({ data: { session: validSession } });

    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('in'));

    await act(async () => {
      captured.cb?.('SIGNED_OUT', null);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(screen.getByTestId('state').textContent).toBe('in');
  });

  it('signs the operator out when the session is genuinely gone from storage', async () => {
    getSession
      .mockResolvedValueOnce({ data: { session: validSession } })
      .mockResolvedValue({ data: { session: null } });

    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('in'));

    await act(async () => {
      captured.cb?.('SIGNED_OUT', null);
      await new Promise((r) => setTimeout(r, 0));
    });

    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('out'));
  });
});

describe('AuthProvider domain enforcement', () => {
  it('does NOT sign out when a refreshed session transiently lacks an email', async () => {
    // Start signed in, then a token-refresh / realtime re-auth re-emits the
    // session with user.email momentarily undefined (the Customers-panel-close
    // logout). This must NOT destroy the session.
    getSession.mockResolvedValue({ data: { session: validSession } });

    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('in'));

    await act(async () => {
      captured.cb?.('TOKEN_REFRESHED', sessionFor(undefined));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(signOut).not.toHaveBeenCalled();
    expect(screen.getByTestId('state').textContent).toBe('in');
  });

  it('STILL signs out a genuinely foreign email (security preserved)', async () => {
    getSession.mockResolvedValue({ data: { session: validSession } });

    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('in'));

    await act(async () => {
      captured.cb?.('SIGNED_IN', sessionFor('attacker@gmail.com'));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(signOut).toHaveBeenCalled();
  });
});
