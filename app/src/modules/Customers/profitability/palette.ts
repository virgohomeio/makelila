/** Colour roles for the profitability charts.
 *
 *  Profit has a meaningful zero, so every value encoding here is *diverging*:
 *  two hues away from a neutral gray midpoint. The pair is red ↔ blue rather
 *  than the red ↔ green a finance dashboard reaches for by reflex — red and
 *  green are the one pair a red-green colourblind reader cannot separate, and
 *  this chart's whole job is telling profit from loss. Red keeps its
 *  conventional "loss" meaning; profit takes blue.
 *
 *  Colour never carries a value alone: every tile and bar is direct-labelled,
 *  and the tables carry the same numbers.
 */

/** Loss → neutral → profit. Symmetric arms, gray at zero. */
export const DIVERGING = {
  lossStrong:  '#7f1d1d',
  loss:        '#b93030',
  lossLight:   '#e08b8b',
  neutral:     '#e8e6e1',
  profitLight: '#9ec5f4',
  profit:      '#2a78d6',
  profitStrong: '#184f95',
} as const;

/** Ink and chrome, matching the muted greys the rest of the module uses. */
export const INK = {
  primary:   '#1a202c',
  secondary: '#4a5568',
  muted:     '#718096',
  grid:      '#e2e8f0',
  axis:      '#cbd5e0',
  surface:   '#ffffff',
} as const;

/** Map a signed value to a diverging step.
 *
 *  `scale` is the magnitude that saturates an arm — normally the larger of the
 *  two extremes in view, so both arms stay on one comparable scale rather than
 *  each stretching to its own max (which would make a -$50 region look as red
 *  as a -$5,000 one). Zero and near-zero land on the neutral step.
 */
export function divergingColor(value: number, scale: number): string {
  if (!Number.isFinite(value) || scale <= 0) return DIVERGING.neutral;
  const t = Math.max(-1, Math.min(1, value / scale));
  if (t <= -0.66) return DIVERGING.lossStrong;
  if (t <= -0.33) return DIVERGING.loss;
  if (t <  -0.02) return DIVERGING.lossLight;
  if (t <=  0.02) return DIVERGING.neutral;
  if (t <   0.33) return DIVERGING.profitLight;
  if (t <   0.66) return DIVERGING.profit;
  return DIVERGING.profitStrong;
}

/** Text that stays legible on a given diverging step. The two darkest steps of
 *  each arm need light text; the rest keep the primary ink. */
export function inkOn(background: string): string {
  return background === DIVERGING.lossStrong
      || background === DIVERGING.loss
      || background === DIVERGING.profit
      || background === DIVERGING.profitStrong
    ? '#ffffff'
    : INK.primary;
}
