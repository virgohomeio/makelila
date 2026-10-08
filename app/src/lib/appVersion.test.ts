import { describe, it, expect, vi } from 'vitest';
import { currentEntryBundle, fetchDeployedEntryBundle, isNewerBuild } from './appVersion';

// The rule behind the "a newer version is deployed" banner. The failure mode
// worth guarding is not a missed update — it is a FALSE one: a banner that
// nags every operator to reload, on every page, because index.html came back
// unreadable. So every uncertain answer has to resolve to "no news".
describe('isNewerBuild', () => {
  const A = 'assets/index-DFrDyVyh.js';
  const B = 'assets/index-BTeYA-JZ.js';

  it('spots a different build on the server', () => {
    expect(isNewerBuild(A, B)).toBe(true);
  });

  it('says nothing when the server is serving what this tab is running', () => {
    expect(isNewerBuild(A, A)).toBe(false);
  });

  // Offline, a captive portal, a 404, an index.html whose shape changed — all
  // arrive here as a null, and none of them is evidence of a new deploy.
  it('treats an unknown answer on either side as no news', () => {
    expect(isNewerBuild(A, null)).toBe(false);
    expect(isNewerBuild(null, B)).toBe(false);
    expect(isNewerBuild(null, null)).toBe(false);
  });
});

describe('currentEntryBundle', () => {
  const docWith = (html: string) =>
    new DOMParser().parseFromString(`<html><head>${html}</head><body></body></html>`, 'text/html');

  it('reads the hashed entry bundle out of the page it booted from', () => {
    const doc = docWith('<script type="module" src="/assets/index-DFrDyVyh.js"></script>');
    expect(currentEntryBundle(doc)).toBe('assets/index-DFrDyVyh.js');
  });

  // Vite emits the entry alongside preloads for the chunks it splits out. Only
  // the entry is content-hashed per build in a way that tracks every change,
  // and picking a module chunk instead would miss deploys that did not touch it.
  it('ignores other chunks on the page', () => {
    const doc = docWith(
      '<script type="module" src="/assets/Fulfillment-BTeYA-JZ.js"></script>' +
      '<script type="module" src="/assets/index-DFrDyVyh.js"></script>',
    );
    expect(currentEntryBundle(doc)).toBe('assets/index-DFrDyVyh.js');
  });

  it('returns null rather than guessing when there is no entry script', () => {
    expect(currentEntryBundle(docWith('<title>x</title>'))).toBeNull();
  });
});

describe('fetchDeployedEntryBundle', () => {
  const html = (name: string) =>
    `<!doctype html><html><head><script type="module" crossorigin src="/${name}"></script>` +
    `</head><body></body></html>`;

  it('reads the entry bundle the server is serving', async () => {
    const f = vi.fn(() => Promise.resolve(
      new Response(html('assets/index-BTeYA-JZ.js'), { status: 200 }),
    )) as unknown as typeof fetch;

    await expect(fetchDeployedEntryBundle(f)).resolves.toBe('assets/index-BTeYA-JZ.js');
  });

  // The browser's own cached copy is precisely what this has to see past —
  // asking for it normally would return the stale HTML this tab already has
  // and conclude, wrongly, that it is up to date.
  it('asks for a copy that bypasses the browser cache', async () => {
    const f = vi.fn(() => Promise.resolve(
      new Response(html('assets/index-BTeYA-JZ.js'), { status: 200 }),
    )) as unknown as typeof fetch;

    await fetchDeployedEntryBundle(f);

    const init = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][1];
    expect(init.cache).toBe('no-store');
  });

  it('reports no news when the request fails or 404s', async () => {
    const boom = vi.fn(() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    await expect(fetchDeployedEntryBundle(boom)).resolves.toBeNull();

    const missing = vi.fn(() => Promise.resolve(
      new Response('not found', { status: 404 }),
    )) as unknown as typeof fetch;
    await expect(fetchDeployedEntryBundle(missing)).resolves.toBeNull();
  });

  it('reports no news when the page carries no entry bundle', async () => {
    const odd = vi.fn(() => Promise.resolve(
      new Response('<!doctype html><html><head></head><body></body></html>', { status: 200 }),
    )) as unknown as typeof fetch;
    await expect(fetchDeployedEntryBundle(odd)).resolves.toBeNull();
  });
});
