import { useAuth } from '../lib/auth';

export function UserBadge() {
  const { profile, user, signOut } = useAuth();
  if (!user) return null;
  const name = profile?.display_name ?? user.email ?? 'User';
  const initial = name[0]?.toUpperCase() ?? '?';

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, color: '#eee',
      fontSize: 11, fontWeight: 600,
    }}>
      <div style={{
        width: 24, height: 24, borderRadius: '50%',
        background: 'var(--color-crimson)', color: '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 10, fontWeight: 800,
      }}>{initial}</div>
      <span>{name}</span>
      <button
        onClick={() => void signOut()}
        style={{
          background: 'transparent', border: '1px solid #333',
          color: '#888', padding: '4px 10px', borderRadius: 4,
          fontSize: 10, fontWeight: 600,
        }}
      >Sign out</button>
    </div>
  );
}
