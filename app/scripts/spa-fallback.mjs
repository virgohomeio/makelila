// SPA fallback for GitHub Pages.
//
// GitHub Pages serves static files; a direct hit on /return or /cancel-order
// 404s because there's no file at that path. The convention is to publish a
// 404.html that's identical to index.html — Pages serves it on any miss,
// and React Router takes over routing client-side.
//
// We use 200.html for hosts that support it (Netlify-style SPA fallback)
// and 404.html for GitHub Pages. Both point at the same SPA shell.

import { copyFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '..', 'dist');
const indexHtml = resolve(dist, 'index.html');

if (!existsSync(indexHtml)) {
  console.error(`spa-fallback: ${indexHtml} not found — did vite build run?`);
  process.exit(1);
}

copyFileSync(indexHtml, resolve(dist, '404.html'));
console.log('spa-fallback: dist/404.html written (copy of index.html)');
