import { useAuth } from '../lib/auth';
import { Navigate } from 'react-router-dom';

export default function Login() {
  const { session, signInWithGoogle, loading } = useAuth();
  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;
  if (session) return <Navigate to="/order-review" replace />;

  return (
    <div style={{
      minHeight: '80vh', display: 'flex', alignItems: 'center',
      justifyContent: 'center', flexDirection: 'column', gap: 20,
      padding: 24,
    }}>
      <img
        src={`${import.meta.env.BASE_URL}vcycene-logo-square.png`}
        alt="VCycene"
        style={{ width: 120, height: 'auto' }}
      />
      <div style={{ textAlign: 'center' }}>
        <h1 style={{
          fontFamily: 'var(--font-logo)',
          fontSize: 32,
          fontWeight: 700,
          letterSpacing: '0.1em',
          color: 'var(--color-crimson)',
          marginBottom: 2,
        }}>make lila</h1>
        <p style={{ fontSize: 12, color: 'var(--color-ink-subtle)', marginTop: 8 }}>
          Internal operations tool for VCycene Inc.
        </p>
      </div>
      <p style={{ fontSize: 12, color: 'var(--color-ink-subtle)' }}>
        Sign in with your @virgohome.io account.
      </p>
      <button
        onClick={() => void signInWithGoogle()}
        style={{
          background: 'var(--color-crimson)', color: '#fff', border: 'none',
          padding: '10px 22px', borderRadius: 6, fontSize: 13, fontWeight: 600,
          letterSpacing: '0.3px', cursor: 'pointer',
        }}
      >Sign in with Google</button>
    </div>
  );
}
