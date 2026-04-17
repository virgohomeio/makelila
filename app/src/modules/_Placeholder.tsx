export function Placeholder({ title }: { title: string }) {
  return (
    <div>
      <h1 style={{ fontSize: 18, fontWeight: 800, color: 'var(--color-crimson)' }}>
        {title}
      </h1>
      <p style={{ fontSize: 11, color: 'var(--color-ink-subtle)', marginTop: 6 }}>
        This module is planned but not yet implemented.
      </p>
    </div>
  );
}
