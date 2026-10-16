import { useEffect, useState } from 'react';
import {
  currentEntryBundle,
  fetchDeployedEntryBundle,
  isNewerBuild,
  VERSION_POLL_MS,
} from '../lib/appVersion';
import styles from './UpdateBanner.module.css';

/** Says so when this tab is running a build the server has replaced.
 *
 *  See lib/appVersion.ts for why. Short version: GitHub Pages caches
 *  index.html for ten minutes and a long-lived tab never re-fetches it at all,
 *  so "I deployed it" and "you are running it" are different facts and nothing
 *  on screen distinguished them. An operator clicked the same button four
 *  times on 2026-10-08 waiting for a feature that went live thirty seconds
 *  after their last attempt.
 *
 *  Deliberately a prompt and not an automatic reload. Reloading out from under
 *  someone mid-form would throw away a half-typed tracking number, and this
 *  app is full of steps that are exactly that. */
export function UpdateBanner() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const running = currentEntryBundle();
    if (!running) return;
    let cancelled = false;

    const check = async () => {
      const deployed = await fetchDeployedEntryBundle();
      if (!cancelled && isNewerBuild(running, deployed)) setStale(true);
    };

    // Not on mount: a tab that has just loaded is by definition current, and
    // a check in the same instant would only race the page it came from.
    const id = setInterval(() => { void check(); }, VERSION_POLL_MS);
    // Coming back to a tab left open is the moment it is most likely behind.
    const onFocus = () => { void check(); };
    window.addEventListener('focus', onFocus);

    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  if (!stale) return null;

  return (
    <div className={styles.banner} role="status" data-testid="update-banner">
      <span>
        A newer version of makeLILA has been deployed — this tab is still running
        the old one.
      </span>
      <button
        type="button"
        className={styles.reload}
        // reload() alone can be served the cached index.html all over again,
        // which is the whole problem. A cache-busting query gets a fresh one.
        onClick={() => {
          const u = new URL(window.location.href);
          u.searchParams.set('v', Date.now().toString(36));
          window.location.replace(u.toString());
        }}
      >Reload now</button>
    </div>
  );
}
