import { useAuth } from '../lib/auth';
import { Navigate } from 'react-router-dom';

export default function Login() {
  const { session, signInWithGoogle, loading } = useAuth();
  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;
  if (session) return <Navigate to="/order-review" replace />;

  return (
    <div style={{
      minHeight: '70vh', display: 'flex', alignItems: 'center',
      justifyContent: 'center', flexDirection: 'column', gap: 16,
    }}>
      <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--color-crimson)' }}>
        Make Lila
      </h1>
      <p style={{ fontSize: 12, color: 'var(--color-ink-subtle)' }}>
        Sign in with your @virgohome.io account.
      </p>
      <button
        onClick={() => void signInWithGoogle()}
        style={{
          background: 'var(--color-crimson)', color: '#fff', border: 'none',
          padding: '10px 20px', borderRadius: 6, fontSize: 12, fontWeight: 700,
        }}
      >Sign in with Google</button>
    </div>
  );
}
