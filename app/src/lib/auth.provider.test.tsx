import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import type { Session } from '@supabase/supabase-js';

// Controllable mock of the singleton client. We capture the
// onAuthStateChange callback so tests can drive auth events, and let each
// test dictate what getSession() resolves to.
type AuthCb = (event: string, session: Session | null) => void;
const captured: { cb: AuthCb | null } = { cb: null };
const getSession = vi.fn();
const unsubscribe = vi.fn();

vi.mock('./supabase', () => ({
  supabase: {
    auth: {
      getSession: () => getSession(),
      onAuthStateChange: (cb: AuthCb) => {
        captured.cb = cb;
        return { data: { subscription: { unsubscribe } } };
      },
      signOut: vi.fn(),
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

const validSession = {
  user: { id: 'u1', email: 'huayi@virgohome.io' },
} as unknown as Session;

beforeEach(() => {
  captured.cb = null;
  getSession.mockReset();
  unsubscribe.mockReset();
});

describe('AuthProvider session resilience', () => {
  it('keeps the operator signed in when a spurious null auth event fires (session still in storage)', async () => {
    // Initial load resolves a valid session; the re-validation after the
    // spurious event ALSO finds the session still present in storage.
    getSession.mockResolvedValue({ data: { session: validSession } });

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('in'));

    // A transient SIGNED_OUT arrives (network blip during silent refresh /
    // late null INITIAL_SESSION). The operator did NOT sign out.
    await act(async () => {
      captured.cb?.('SIGNED_OUT', null);
      // let the deferred re-validation run
      await new Promise((r) => setTimeout(r, 0));
    });

    // Must NOT be booted to the login screen.
    expect(screen.getByTestId('state').textContent).toBe('in');
  });

  it('signs the operator out when the session is genuinely gone from storage', async () => {
    // Initial load: valid. Re-validation after the event: storage cleared.
    getSession
      .mockResolvedValueOnce({ data: { session: validSession } })
      .mockResolvedValue({ data: { session: null } });

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('in'));

    await act(async () => {
      captured.cb?.('SIGNED_OUT', null);
      await new Promise((r) => setTimeout(r, 0));
    });

    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('out'));
  });
});
