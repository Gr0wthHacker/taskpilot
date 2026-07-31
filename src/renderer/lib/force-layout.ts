/**
 * Minimal force-directed graph layout (Wave 17).
 *
 * A hand-rolled Fruchterman-Reingold-ish simulation — no graph library. Three
 * forces per tick:
 *
 *   1. Repulsion  — every pair of nodes pushes apart (Coulomb-style, ~1/d).
 *   2. Spring     — edges pull their endpoints toward an ideal length (Hooke).
 *   3. Gravity    — a weak pull toward the center so disconnected components
 *                   don't drift off-canvas.
 *
 * The simulation is fully DETERMINISTIC: nodes seed on a circle by their index
 * (a stable order derived from the input), and there is no randomness anywhere.
 * The same `{ nodes, edges }` input always yields the same positions, which
 * keeps the rendered graph stable across re-renders and makes the layout
 * unit-testable.
 *
 * Runs synchronously. 200 nodes × 300 iterations is well under a frame budget
 * for a one-time layout, and callers memoize per graph (see `Graph.tsx`).
 */

export interface LayoutNode {
  id: string;
}

export interface LayoutEdge {
  source: string;
  target: string;
}

export interface Point {
  x: number;
  y: number;
}

export interface LayoutOptions {
  width: number;
  height: number;
  iterations?: number;
  /** Repulsion strength. Larger = nodes spread farther apart. */
  repulsion?: number;
  /** Spring stiffness for edges in [0, 1]. */
  springStrength?: number;
  /** Ideal edge length in px. */
  springLength?: number;
  /** Center-gravity strength in [0, 1]. */
  gravity?: number;
}

const DEFAULTS = {
  iterations: 300,
  repulsion: 6000,
  springStrength: 0.08,
  springLength: 90,
  gravity: 0.02,
} as const;

/**
 * Compute a stable 2D layout for a graph. Returns a map of node id → position.
 * Positions are clamped to sit within `[margin, width-margin]` ×
 * `[margin, height-margin]` so the renderer never has to scroll to find a
 * node, and every coordinate is guaranteed finite (never NaN/Infinity).
 */
export function computeLayout(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  options: LayoutOptions,
): Map<string, Point> {
  const width = options.width;
  const height = options.height;
  const iterations = options.iterations ?? DEFAULTS.iterations;
  const repulsion = options.repulsion ?? DEFAULTS.repulsion;
  const springStrength = options.springStrength ?? DEFAULTS.springStrength;
  const springLength = options.springLength ?? DEFAULTS.springLength;
  const gravity = options.gravity ?? DEFAULTS.gravity;

  const positions = new Map<string, Point>();
  if (nodes.length === 0) return positions;

  const cx = width / 2;
  const cy = height / 2;
  const margin = 24;

  // Seed on a circle, deterministically by index. A single node lands dead
  // center. The radius is a fraction of the smaller dimension so the initial
  // ring fits the canvas regardless of node count.
  const seedRadius = Math.min(width, height) * 0.35;
  nodes.forEach((node, i) => {
    if (nodes.length === 1) {
      positions.set(node.id, { x: cx, y: cy });
      return;
    }
    const angle = (2 * Math.PI * i) / nodes.length;
    positions.set(node.id, {
      x: cx + seedRadius * Math.cos(angle),
      y: cy + seedRadius * Math.sin(angle),
    });
  });

  // Single node needs no relaxation.
  if (nodes.length === 1) {
    clampAll(positions, width, height, margin);
    return positions;
  }

  // Filter edges to those whose endpoints both exist — a stray edge to a
  // node not in the set would corrupt the spring pass.
  const validEdges = edges.filter(
    (e) => positions.has(e.source) && positions.has(e.target) && e.source !== e.target,
  );

  // Initial temperature for simulated-annealing-style cooling: displacement
  // per tick is capped at `temp`, which decays linearly to ~0.
  const initialTemp = Math.min(width, height) * 0.1;

  for (let iter = 0; iter < iterations; iter += 1) {
    const temp = initialTemp * (1 - iter / iterations);
    const disp = new Map<string, Point>();
    for (const node of nodes) disp.set(node.id, { x: 0, y: 0 });

    // --- Repulsion: O(n^2) over the node pairs. Fine at our scale (≤200). ---
    for (let i = 0; i < nodes.length; i += 1) {
      const a = positions.get(nodes[i].id) as Point;
      const da = disp.get(nodes[i].id) as Point;
      for (let j = i + 1; j < nodes.length; j += 1) {
        const b = positions.get(nodes[j].id) as Point;
        const db = disp.get(nodes[j].id) as Point;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distSq = dx * dx + dy * dy;
        if (distSq < 0.01) {
          // Coincident nodes: nudge apart along a deterministic axis derived
          // from the index difference so we never divide by zero and never
          // introduce randomness.
          dx = (i - j) % 2 === 0 ? 0.1 : -0.1;
          dy = 0.1;
          distSq = dx * dx + dy * dy;
        }
        const dist = Math.sqrt(distSq);
        const force = repulsion / distSq;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        da.x += fx;
        da.y += fy;
        db.x -= fx;
        db.y -= fy;
      }
    }

    // --- Spring: pull edge endpoints toward `springLength`. ----------------
    for (const edge of validEdges) {
      const a = positions.get(edge.source) as Point;
      const b = positions.get(edge.target) as Point;
      const da = disp.get(edge.source) as Point;
      const db = disp.get(edge.target) as Point;
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 0.01) {
        dx = 0.1;
        dy = 0;
        dist = 0.1;
      }
      const force = springStrength * (dist - springLength);
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      da.x += fx;
      da.y += fy;
      db.x -= fx;
      db.y -= fy;
    }

    // --- Gravity: weak pull toward center. ---------------------------------
    for (const node of nodes) {
      const p = positions.get(node.id) as Point;
      const d = disp.get(node.id) as Point;
      d.x += (cx - p.x) * gravity;
      d.y += (cy - p.y) * gravity;
    }

    // --- Integrate: apply displacement, capped by temperature. -------------
    for (const node of nodes) {
      const p = positions.get(node.id) as Point;
      const d = disp.get(node.id) as Point;
      const len = Math.sqrt(d.x * d.x + d.y * d.y);
      if (len > 0.0001) {
        const capped = Math.min(len, temp);
        p.x += (d.x / len) * capped;
        p.y += (d.y / len) * capped;
      }
      // Defensive clamp against any numerical drift to non-finite values.
      if (!Number.isFinite(p.x)) p.x = cx;
      if (!Number.isFinite(p.y)) p.y = cy;
    }
  }

  clampAll(positions, width, height, margin);
  return positions;
}

/**
 * Clamp every position into the drawable area. Mutates in place.
 */
function clampAll(
  positions: Map<string, Point>,
  width: number,
  height: number,
  margin: number,
): void {
  const minX = margin;
  const maxX = Math.max(margin, width - margin);
  const minY = margin;
  const maxY = Math.max(margin, height - margin);
  for (const p of positions.values()) {
    p.x = clamp(Number.isFinite(p.x) ? p.x : (minX + maxX) / 2, minX, maxX);
    p.y = clamp(Number.isFinite(p.y) ? p.y : (minY + maxY) / 2, minY, maxY);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
