/**
 * Tiny inline-SVG chart primitives for the Reports dashboard.
 *
 * We deliberately avoid pulling in a chart library — every helper here is
 * pure math (no React, no DOM) and the chart components below render the
 * results with hand-written SVG. Two reasons:
 *
 *   1. Bundle size: Recharts/Visx add 50–150kb gzipped for what amounts to
 *      a handful of bars and a sparkline.
 *   2. Theming: the Tailwind tokens (`text-primary`, `text-muted-foreground`,
 *      etc.) play nicer with raw `<rect fill="currentColor">` than with the
 *      style props chart libs expect.
 *
 * The functions here cover the four primitives the dashboard needs:
 *   - `scaleLinear` — map a [domainMin, domainMax] range to a [0, rangeMax]
 *     pixel range. Returns 0 for empty domains so callers don't NaN-render.
 *   - `niceMax` — round a max value up to a friendly number for axis ticks.
 *   - `pickTicks` — produce ~4 evenly-spaced ticks between 0 and `max`.
 *   - `formatNumber` — short human-readable count (e.g. 1.2k).
 *   - `polylinePoints` — turn an array of `(x, y)` pairs into the `points`
 *     string for an SVG `<polyline>` / `<polygon>`.
 *   - `heatColor` — map an intensity in [0, 1] to a Tailwind class on the
 *     primary palette. Used by the heat map cells.
 */

/* -------------------------------------------------------------------------- */
/*  Scales                                                                    */
/* -------------------------------------------------------------------------- */

export function scaleLinear(
  value: number,
  domainMin: number,
  domainMax: number,
  rangeMax: number,
): number {
  if (!Number.isFinite(value)) return 0;
  if (domainMax === domainMin) return 0;
  const t = (value - domainMin) / (domainMax - domainMin);
  return Math.max(0, Math.min(1, t)) * rangeMax;
}

/**
 * Round `max` up to a "nice" number — the next 1/2/5 × 10^k that's >= max.
 * Returns 1 for zero / negative inputs so axis math never divides by zero.
 */
export function niceMax(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1;
  const exp = Math.floor(Math.log10(max));
  const base = Math.pow(10, exp);
  const norm = max / base;
  let nice: number;
  if (norm <= 1) nice = 1;
  else if (norm <= 2) nice = 2;
  else if (norm <= 5) nice = 5;
  else nice = 10;
  return nice * base;
}

/**
 * Produce ~`count` evenly-spaced ticks from 0 to `max` (inclusive). Used
 * for the y-axis label column on bar/line charts.
 */
export function pickTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const step = max / count;
  const out: number[] = [];
  for (let i = 0; i <= count; i++) {
    out.push(Math.round(step * i * 100) / 100);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Formatting                                                                */
/* -------------------------------------------------------------------------- */

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '–';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  if (abs >= 100) return n.toFixed(0);
  if (abs >= 10) return n.toFixed(0);
  return n.toFixed(0);
}

/**
 * Format a fractional-hour value as either "Nh" (>= 1h) or "Nm" (< 1h).
 * Returns "–" for null/NaN so the UI can render placeholder cells.
 */
export function formatHours(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) return '–';
  if (hours >= 24) {
    const days = hours / 24;
    return `${days.toFixed(days < 10 ? 1 : 0)}d`;
  }
  if (hours >= 1) return `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
  const mins = Math.round(hours * 60);
  return `${Math.max(1, mins)}m`;
}

/**
 * Compact a YYYY-MM-DD into "MMM D" for axis labels (e.g. "May 27").
 */
export function formatDateLabel(iso: string): string {
  // We avoid `new Date(iso)` because it parses YYYY-MM-DD as local-midnight
  // in some engines and UTC-midnight in others, leading to off-by-one labels.
  // Manual parse keeps things deterministic.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const year = Number(m[1]);
  const monthIdx = Number(m[2]) - 1;
  const day = Number(m[3]);
  const MONTHS = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  void year;
  return `${MONTHS[monthIdx] ?? '?'} ${day}`;
}

/* -------------------------------------------------------------------------- */
/*  SVG helpers                                                               */
/* -------------------------------------------------------------------------- */

export interface Point {
  x: number;
  y: number;
}

export function polylinePoints(points: Point[]): string {
  return points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
}

/* -------------------------------------------------------------------------- */
/*  Heat map color                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Map an intensity in [0, 1] to a Tailwind background utility on the
 * primary palette. We avoid arbitrary `bg-[#…]` values so theme toggles
 * still flow through.
 */
export function heatColor(intensity: number): string {
  const t = Math.max(0, Math.min(1, intensity));
  if (t === 0) return 'bg-muted/40';
  if (t < 0.2) return 'bg-primary/10';
  if (t < 0.4) return 'bg-primary/20';
  if (t < 0.6) return 'bg-primary/40';
  if (t < 0.8) return 'bg-primary/60';
  return 'bg-primary/80';
}

/**
 * Pick a text color that contrasts against the heat color above. Cells with
 * a strong primary background need foreground text; lighter cells stay on
 * the default body color.
 */
export function heatTextColor(intensity: number): string {
  const t = Math.max(0, Math.min(1, intensity));
  if (t >= 0.6) return 'text-primary-foreground';
  return 'text-foreground';
}
