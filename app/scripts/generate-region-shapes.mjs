#!/usr/bin/env node
/** Regenerate src/lib/regionShapes.ts — the real province/state outlines the
 *  profitability geography map draws.
 *
 *  Run when the outlines need to change (a new projection, a finer or coarser
 *  simplification). Nothing at runtime depends on this script or on the
 *  network; it writes a plain TypeScript module of pre-projected SVG paths.
 *
 *    node scripts/generate-region-shapes.mjs [path-to-ne_50m_admin_1.geojson]
 *
 *  With no argument it downloads Natural Earth 1:50m admin-1 from GitHub.
 *
 *  Projection is a composite, the same shape d3's albersUsa takes: one Albers
 *  conic equal-area for the mainland of Canada and the lower 48, and separate
 *  smaller ones for Alaska and Hawaii dropped into the empty bottom-left of
 *  the frame. Alaska in the mainland cone would be a smeared crescent three
 *  times the size of Ontario, and Hawaii would push the frame 3,000km west for
 *  eight pixels of island.
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../src/lib/regionShapes.ts');
const SOURCE_URL =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_1_states_provinces.geojson';

/* ------------------------------------------------------------------ layout */

const TARGET_W = 940;         // mainland drawing width, px
const GUTTER = 132;           // right-hand column the callout labels live in
const PAD = 8;
const TOLERANCE = 0.55;       // Douglas-Peucker, in output px
const MIN_RING_PX = 3.2;      // drop islands smaller than this across
const CAPTION_ROOM = 26;      // bottom strip the inset captions sit in

/* -------------------------------------------------------------- projection */

const RAD = Math.PI / 180;

/** Albers conic equal-area. Returns raw units; caller scales and translates.
 *  y comes back increasing northward, so the caller flips it for SVG. */
function albers({ lon0, lat0, phi0, phi1 }) {
  const sp0 = Math.sin(phi0 * RAD);
  const n = (sp0 + Math.sin(phi1 * RAD)) / 2;
  const C = Math.cos(phi0 * RAD) ** 2 + 2 * n * sp0;
  const rho0 = Math.sqrt(C - 2 * n * Math.sin(lat0 * RAD)) / n;
  return ([lon, lat]) => {
    const rho = Math.sqrt(Math.max(0, C - 2 * n * Math.sin(lat * RAD))) / n;
    const theta = n * ((lon - lon0) * RAD);
    return [rho * Math.sin(theta), rho0 - rho * Math.cos(theta)];
  };
}

// Parallels chosen to spread the distortion across the whole span we draw:
// 25°N (Key West) to 70°N (the Arctic coast the territories reach).
const MAINLAND = albers({ lon0: -96, lat0: 44, phi0: 33, phi1: 62 });
const ALASKA   = albers({ lon0: -152, lat0: 55, phi0: 55, phi1: 65 });
const HAWAII   = albers({ lon0: -157, lat0: 20, phi0: 8,  phi1: 18 });

const PROJECTION_OF = code =>
  code === 'US-AK' ? 'alaska' : code === 'US-HI' ? 'hawaii' : 'mainland';

const PROJECTIONS = { mainland: MAINLAND, alaska: ALASKA, hawaii: HAWAII };

/* ------------------------------------------------------------- ring helpers */

function ringsOf(geometry) {
  // Only outer rings. Interior holes at this scale are lakes we do not draw.
  if (geometry.type === 'Polygon') return [geometry.coordinates[0]];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.map(p => p[0]);
  return [];
}

function bbox(points) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

function ringArea(points) {
  let a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    a += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  }
  return Math.abs(a) / 2;
}

/** Perpendicular distance from p to segment ab, squared. */
function segDist2(p, a, b) {
  let x = a[0], y = a[1];
  let dx = b[0] - x, dy = b[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x = b[0]; y = b[1]; }
    else if (t > 0) { x += dx * t; y += dy * t; }
  }
  dx = p[0] - x; dy = p[1] - y;
  return dx * dx + dy * dy;
}

/** Douglas-Peucker. Iterative so a 12,000-point Nunavut ring cannot blow the
 *  stack. */
function simplify(points, tolerance) {
  if (points.length < 3) return points;
  const tol2 = tolerance * tolerance;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let index = -1, maxD = tol2;
    for (let i = first + 1; i < last; i++) {
      const d = segDist2(points[i], points[first], points[last]);
      if (d > maxD) { maxD = d; index = i; }
    }
    if (index !== -1) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function pointInRing(px, py, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function distToRing(px, py, ring) {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const d = segDist2([px, py], ring[j], ring[i]);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** Largest inscribed circle of a ring, by grid search then local refinement.
 *
 *  The centre is where a label can sit without falling in the sea, and the
 *  radius is how much room that label has — which is what decides whether a
 *  region can carry its own number or needs a callout in the gutter.
 */
function poleOfInaccessibility(ring) {
  const b = bbox(ring);
  let best = null, bestR = -Infinity;
  const STEPS = 40;
  for (let i = 0; i <= STEPS; i++) {
    for (let j = 0; j <= STEPS; j++) {
      const x = b.x0 + (b.w * i) / STEPS;
      const y = b.y0 + (b.h * j) / STEPS;
      if (!pointInRing(x, y, ring)) continue;
      const r = distToRing(x, y, ring);
      if (r > bestR) { bestR = r; best = [x, y]; }
    }
  }
  if (!best) return { x: b.x0 + b.w / 2, y: b.y0 + b.h / 2, r: 0 };
  // Refine: shrink the search box around the winner three times.
  let step = Math.max(b.w, b.h) / STEPS;
  for (let pass = 0; pass < 4; pass++) {
    step /= 2.5;
    for (let i = -3; i <= 3; i++) {
      for (let j = -3; j <= 3; j++) {
        const x = best[0] + i * step, y = best[1] + j * step;
        if (!pointInRing(x, y, ring)) continue;
        const r = distToRing(x, y, ring);
        if (r > bestR) { bestR = r; best = [x, y]; }
      }
    }
  }
  return { x: best[0], y: best[1], r: bestR };
}

/* ------------------------------------------------------------------- build */

async function loadSource() {
  const arg = process.argv[2];
  if (arg && existsSync(arg)) return JSON.parse(readFileSync(arg, 'utf8'));
  process.stderr.write(`fetching ${SOURCE_URL}\n`);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`source fetch failed: ${res.status}`);
  return res.json();
}

const geo = await loadSource();

/** code -> [ring, ...] in raw projected units, per projection frame. */
const raw = new Map();
for (const f of geo.features) {
  const country = f.properties.iso_a2;
  if (country !== 'US' && country !== 'CA') continue;
  const postal = f.properties.postal ?? f.properties.iso_3166_2?.split('-')[1];
  if (!postal) continue;
  const code = `${country}-${postal}`;
  const project = PROJECTIONS[PROJECTION_OF(code)];

  const rings = [];
  for (const ring of ringsOf(f.geometry)) {
    // The Aleutians run past the antimeridian into positive longitude; in a
    // cone centred on -152 they would swing round to the far side of the map.
    if (ring.some(([lon]) => lon > 0)) continue;
    rings.push(ring.map(project));
  }
  if (!rings.length) continue;
  raw.set(code, (raw.get(code) ?? []).concat(rings));
}

if (raw.size !== 64) {
  throw new Error(`expected 64 regions (13 provinces + 51 states), got ${raw.size}`);
}

// One scale for the mainland; the insets get their own so Alaska reads as an
// inset rather than as the largest thing on the map.
const mainlandPoints = [...raw].filter(([c]) => PROJECTION_OF(c) === 'mainland')
  .flatMap(([, rings]) => rings.flat());
const mb = bbox(mainlandPoints);
const scale = TARGET_W / mb.w;

const frames = {
  mainland: { scale, tx: PAD - mb.x0 * scale, ty: 0 /* set below */ },
};
// y flips: SVG grows downward, the projection grows northward.
frames.mainland.ty = PAD + mb.y1 * scale;
const mainlandH = mb.h * scale;

const place = (frame, [x, y]) => [
  x * frame.scale + frame.tx,
  frame.ty - y * frame.scale,
];

/** Project a region's rings, drop the specks, simplify, biggest ring first. */
function drawRings(rings, frame) {
  return rings
    .map(r => r.map(p => place(frame, p)))
    .filter(r => {
      const b = bbox(r);
      return Math.max(b.w, b.h) >= MIN_RING_PX;
    })
    .map(r => simplify(r, TOLERANCE))
    .filter(r => r.length >= 3)
    .sort((a, b) => ringArea(b) - ringArea(a));
}

/** A frame that lands a region's *drawn* extent at (left, bottom).
 *
 *  Drawn, not projected: both insets trail specks far off their main body —
 *  Alaska's outer Aleutians, Hawaii's northwestern atolls out at Kure — and
 *  every one of those falls under MIN_RING_PX and never reaches the page.
 *  Aligning on the raw bbox would budget hundreds of pixels for islands
 *  nobody sees, and shove the inset out across Florida.
 */
function fitFrame(rings, scale, left, bottom) {
  const drawn = bbox(drawRings(rings, { scale, tx: 0, ty: 0 }).flat());
  return { scale, tx: left - drawn.x0, ty: bottom - drawn.y1 };
}

// Alaska and Hawaii sit side by side along the bottom of the frame, in the
// empty ocean south-west of California. Neither is at mainland scale — Alaska
// shrinks so it does not outweigh Ontario, Hawaii grows so its eight islands
// are big enough to colour and click. Both get a captioned frame saying so.
const insetLeft = PAD + 4;
const insetBottom = PAD + mainlandH;
frames.alaska = fitFrame(raw.get('US-AK'), scale * 0.33, insetLeft, insetBottom);
const drawnAlaska = bbox(drawRings(raw.get('US-AK'), frames.alaska).flat());
frames.hawaii = fitFrame(raw.get('US-HI'), scale * 0.95, drawnAlaska.x1 + 30, insetBottom);

const round = v => Math.round(v * 10) / 10;

const shapes = [];
for (const [code, rings] of raw) {
  const placed = drawRings(rings, frames[PROJECTION_OF(code)]);

  if (!placed.length) throw new Error(`${code} simplified away to nothing`);

  const d = placed
    .map(r => `M${r.map(([x, y]) => `${round(x)},${round(y)}`).join('L')}Z`)
    .join('');

  const pole = poleOfInaccessibility(placed[0]);
  shapes.push({
    code,
    d,
    labelX: round(pole.x),
    labelY: round(pole.y),
    room: round(pole.r),
  });
}

shapes.sort((a, b) => a.code.localeCompare(b.code));

const all = shapes.flatMap(s =>
  s.d.split('M').filter(Boolean).flatMap(seg =>
    seg.replace('Z', '').split('L').map(pt => pt.split(',').map(Number))));
const total = bbox(all);
const width = Math.ceil(total.x1 + PAD + GUTTER);
const height = Math.ceil(total.y1 + PAD + CAPTION_ROOM);

const bytes = shapes.reduce((n, s) => n + s.d.length, 0);
process.stderr.write(`64 regions, ${(bytes / 1024).toFixed(1)}kB of path data\n`);

const body = shapes
  .map(s => `  { code: '${s.code}', labelX: ${s.labelX}, labelY: ${s.labelY}, room: ${s.room}, d: '${s.d}' },`)
  .join('\n');

const insetBoxes = [['Alaska', 'US-AK'], ['Hawaii', 'US-HI']]
  .map(([label, code]) => {
    const shape = shapes.find(s => s.code === code);
    const pts = shape.d.split('M').filter(Boolean).flatMap(seg =>
      seg.replace('Z', '').split('L').map(pt => pt.split(',').map(Number)));
    const b = bbox(pts);
    return `  { label: '${label}', code: '${code}', x: ${round(b.x0)}, y: ${round(b.y0)},`
         + ` width: ${round(b.w)}, height: ${round(b.h)} },`;
  })
  .join('\n');

writeFileSync(OUT, `/* GENERATED FILE — do not edit by hand.
 *
 *  Province and state outlines for the profitability geography map, projected
 *  once at build time so the app ships no geo library and makes no network
 *  call to draw a map.
 *
 *  Regenerate with:  node scripts/generate-region-shapes.mjs
 *  Source: Natural Earth 1:50m admin-1 states/provinces (public domain).
 *
 *  Projection is composite, like d3's albersUsa: an Albers conic equal-area
 *  covering Canada and the lower 48, plus separate smaller cones for Alaska
 *  and Hawaii placed in the empty bottom-left of the frame.
 */

export type RegionShape = {
  /** 'CA-ON' / 'US-CA' — the same key the customer_profitability view emits. */
  code: string;
  /** SVG path in MAP_VIEWBOX coordinates. One subpath per island group. */
  d: string;
  /** Centre of the largest circle that fits inside the region's main body —
   *  where a label can sit without falling in the sea. */
  labelX: number;
  labelY: number;
  /** Radius of that circle, in px. How much room a label has: this is what
   *  decides whether a region carries its own number or needs a callout. */
  room: number;
};

export const REGION_SHAPES: RegionShape[] = [
${body}
];

export const MAP_VIEWBOX = { width: ${width}, height: ${height} } as const;

/** Right-hand column reserved for callout labels, in viewBox units. */
export const MAP_GUTTER = ${GUTTER};

/** The two insets, so the map can caption them and rule them off from the
 *  mainland — their scale is not the mainland's and the frame has to say so. */
export const MAP_INSETS = [
${insetBoxes}
] as const;
`);

process.stderr.write(`wrote ${OUT} (viewBox ${width}x${height})\n`);
