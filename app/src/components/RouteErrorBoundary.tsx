import { Component, type ReactNode } from 'react';

// A stale-chunk error happens when a new build was deployed while a page was
// open: the cached index.html references a hashed chunk that no longer exists,
// so the lazy import() rejects. React's <Suspense> does NOT catch that, so
// without a boundary the whole app white-screens.
function isChunkLoadError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)) || '';
  const name = err instanceof Error ? err.name : '';
  return (
    name === 'ChunkLoadError' ||
    /dynamically imported module|Failed to fetch dynamically|Importing a module script failed|Loading chunk .* failed/i.test(msg)
  );
}

type Props = { children: ReactNode; label?: string };
type State = { error: Error | null };

export class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    if (isChunkLoadError(error)) {
      // Reload to pull the fresh build — but guard against a loop: only
      // auto-reload if we haven't just done so (a genuinely broken chunk would
      // otherwise reload forever).
      const KEY = 'route-chunk-reload-at';
      const last = Number(sessionStorage.getItem(KEY) || 0);
      if (Date.now() - last > 10_000) {
        sessionStorage.setItem(KEY, String(Date.now()));
        window.location.reload();
      }
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const chunk = isChunkLoadError(error);
    return (
      <div style={{ padding: 24, color: '#4a5568' }}>
        <h2 style={{ marginTop: 0 }}>{chunk ? 'A refresh is needed' : 'Something went wrong'}</h2>
        <p style={{ maxWidth: 620 }}>
          {chunk
            ? 'A new version was just deployed. Reload to load the latest.'
            : `The ${this.props.label ?? 'page'} hit an error and could not render. Reload to try again; if it persists, send this message to the team.`}
        </p>
        {!chunk && (
          <pre style={{ background: '#f7fafc', padding: 12, borderRadius: 6, overflow: 'auto', fontSize: 12, maxWidth: 620 }}>
            {error.message}
          </pre>
        )}
        <button
          onClick={() => { sessionStorage.removeItem('route-chunk-reload-at'); window.location.reload(); }}
          style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid #2b6cb0', background: '#2b6cb0', color: '#fff', cursor: 'pointer' }}
        >Reload</button>
      </div>
    );
  }
}
