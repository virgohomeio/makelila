// "It's not live" — noticing that the tab is running yesterday's build.
//
// GitHub Pages serves index.html with `cache-control: max-age=600`, so for ten
// minutes after a deploy a browser that already has the page keeps handing the
// old HTML — and therefore the old hashed JS bundle — to anyone who reloads
// normally. A tab left open overnight can be arbitrarily further behind: it
// never re-fetches the HTML at all.
//
// On 2026-10-08 that cost an operator four attempts at the same button. The
// code that queues the EZ Trans handoff email went live at 17:50:54; their
// last click was at 17:50:24. They were pressing the right button on a bundle
// that did not have the feature yet, and nothing on the page could have told
// them so — which reads as "the app is broken", because from where they sit
// that is exactly what it looks like.
//
// So the app watches for its own replacement. The entry bundle's filename is
// content-hashed by Vite, so it changes on any deploy that changes the code:
// fetch index.html past the cache, read the hash out of it, and compare it to
// the one this tab actually booted from. Different means a newer build is on
// the server.
//
// `cache: 'no-store'` defeats the browser's copy. It cannot defeat the CDN
// edge, which may hold its own for up to the same ten minutes — so this
// shortens "indefinitely behind" to "at most ten minutes behind", and says so
// out loud rather than leaving the operator to guess.

/** How often to look. Ten minutes is the cache window itself; a minute is
 *  often enough to catch a deploy promptly without being a poll of any
 *  consequence — one conditional GET of a 3 KB document. */
export const VERSION_POLL_MS = 60_000;

/** The entry bundle this tab is running, as a filename.
 *
 *  Read from the DOM rather than injected at build time: the script tag is
 *  already in the page with the hash Vite gave it, and a build-time constant
 *  would be one more thing that can disagree with what actually loaded. */
export function currentEntryBundle(doc: Document = document): string | null {
  const scripts = Array.from(doc.querySelectorAll('script[src]')) as HTMLScriptElement[];
  for (const s of scripts) {
    const m = s.getAttribute('src')?.match(/assets\/index-[A-Za-z0-9_-]+\.js/);
    if (m) return m[0];
  }
  return null;
}

/** The entry bundle the server is serving right now, from a copy of
 *  index.html fetched past the browser cache. Null when it cannot be
 *  determined — offline, a captive portal, a 404 — which must read as "no
 *  news", never as "a new version exists". */
export async function fetchDeployedEntryBundle(
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl(`${import.meta.env.BASE_URL}index.html`, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' },
    });
    if (!res.ok) return null;
    const html = await res.text();
    return html.match(/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0] ?? null;
  } catch {
    return null;
  }
}

/** Is `deployed` a different build from `running`?
 *
 *  Both have to be known. A missing answer on either side is not a difference
 *  — an unreadable index.html that nagged every operator to reload would be a
 *  worse bug than the one this exists to fix. */
export function isNewerBuild(running: string | null, deployed: string | null): boolean {
  return !!running && !!deployed && running !== deployed;
}
