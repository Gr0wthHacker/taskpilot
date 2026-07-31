/**
 * Force-directed layout tests (Wave 17).
 *
 * The layout is deterministic (seeded on a circle by index, no randomness), so
 * we assert:
 *   - same input → byte-for-byte identical output (stability across renders)
 *   - every coordinate is finite (never NaN/Infinity), including degenerate
 *     inputs (coincident seeds, self-loops, dangling edges)
 *   - every node lands within the canvas bounds (after clamping)
 *   - empty input yields an empty map; single node centers
 */

import { describe, expect, it } from 'vitest';

import {
  computeLayout,
  type LayoutEdge,
  type LayoutNode,
} from '@/renderer/lib/force-layout';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

const WIDTH = 1200;
const HEIGHT = 800;
const MARGIN = 24;

function makeNodes(n: number): LayoutNode[] {
  return Array.from({ length: n }, (_, i) => ({ id: `n${i}` }));
}

function chainEdges(n: number): LayoutEdge[] {
  const edges: LayoutEdge[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    edges.push({ source: `n${i}`, target: `n${i + 1}` });
  }
  return edges;
}

function allFinite(positions: Map<string, { x: number; y: number }>): boolean {
  for (const p of positions.values()) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
  }
  return true;
}

function withinBounds(positions: Map<string, { x: number; y: number }>): boolean {
  for (const p of positions.values()) {
    if (p.x < MARGIN - 0.001 || p.x > WIDTH - MARGIN + 0.001) return false;
    if (p.y < MARGIN - 0.001 || p.y > HEIGHT - MARGIN + 0.001) return false;
  }
  return true;
}

function serialize(positions: Map<string, { x: number; y: number }>): string {
  return Array.from(positions.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([id, p]) => `${id}:${p.x.toFixed(6)},${p.y.toFixed(6)}`)
    .join('|');
}

/* -------------------------------------------------------------------------- */
/*  Tests                                                                     */
/* -------------------------------------------------------------------------- */

describe('force-layout', () => {
  describe('determinism', () => {
    it('produces identical output for identical input', () => {
      const nodes = makeNodes(20);
      const edges = chainEdges(20);
      const a = computeLayout(nodes, edges, { width: WIDTH, height: HEIGHT });
      const b = computeLayout(nodes, edges, { width: WIDTH, height: HEIGHT });
      expect(serialize(a)).toBe(serialize(b));
    });

    it('is stable across a smaller iteration budget too', () => {
      const nodes = makeNodes(10);
      const edges = chainEdges(10);
      const a = computeLayout(nodes, edges, {
        width: WIDTH,
        height: HEIGHT,
        iterations: 50,
      });
      const b = computeLayout(nodes, edges, {
        width: WIDTH,
        height: HEIGHT,
        iterations: 50,
      });
      expect(serialize(a)).toBe(serialize(b));
    });
  });

  describe('no NaN / finite positions', () => {
    it('keeps all positions finite for a normal graph', () => {
      const nodes = makeNodes(30);
      const edges = chainEdges(30);
      const pos = computeLayout(nodes, edges, { width: WIDTH, height: HEIGHT });
      expect(allFinite(pos)).toBe(true);
    });

    it('survives dangling edges (endpoints not in node set)', () => {
      const nodes = makeNodes(3);
      const edges: LayoutEdge[] = [
        { source: 'n0', target: 'n1' },
        { source: 'n1', target: 'ghost' }, // target missing
        { source: 'phantom', target: 'n2' }, // source missing
      ];
      const pos = computeLayout(nodes, edges, { width: WIDTH, height: HEIGHT });
      expect(allFinite(pos)).toBe(true);
      expect(pos.size).toBe(3);
    });

    it('survives self-loops without dividing by zero', () => {
      const nodes = makeNodes(4);
      const edges: LayoutEdge[] = [
        { source: 'n0', target: 'n0' }, // self loop — should be ignored
        { source: 'n0', target: 'n1' },
      ];
      const pos = computeLayout(nodes, edges, { width: WIDTH, height: HEIGHT });
      expect(allFinite(pos)).toBe(true);
    });

    it('separates a fully disconnected node set without NaN', () => {
      const nodes = makeNodes(15);
      const pos = computeLayout(nodes, [], { width: WIDTH, height: HEIGHT });
      expect(allFinite(pos)).toBe(true);
    });
  });

  describe('bounds', () => {
    it('clamps every node within the canvas (minus margin)', () => {
      const nodes = makeNodes(40);
      const edges = chainEdges(40);
      const pos = computeLayout(nodes, edges, { width: WIDTH, height: HEIGHT });
      expect(withinBounds(pos)).toBe(true);
    });

    it('keeps a dense star graph in bounds', () => {
      const nodes = makeNodes(25);
      const edges: LayoutEdge[] = [];
      for (let i = 1; i < 25; i += 1) edges.push({ source: 'n0', target: `n${i}` });
      const pos = computeLayout(nodes, edges, { width: WIDTH, height: HEIGHT });
      expect(withinBounds(pos)).toBe(true);
      expect(allFinite(pos)).toBe(true);
    });
  });

  describe('degenerate inputs', () => {
    it('returns an empty map for no nodes', () => {
      const pos = computeLayout([], [], { width: WIDTH, height: HEIGHT });
      expect(pos.size).toBe(0);
    });

    it('centers a single node', () => {
      const pos = computeLayout([{ id: 'solo' }], [], {
        width: WIDTH,
        height: HEIGHT,
      });
      const p = pos.get('solo');
      expect(p).toBeDefined();
      expect(p?.x).toBeCloseTo(WIDTH / 2, 5);
      expect(p?.y).toBeCloseTo(HEIGHT / 2, 5);
    });

    it('handles two nodes with the same seed slot without collapsing', () => {
      // Two nodes always seed on opposite arcs of the circle, so they should
      // never coincide and the output stays finite.
      const pos = computeLayout(makeNodes(2), [{ source: 'n0', target: 'n1' }], {
        width: WIDTH,
        height: HEIGHT,
      });
      expect(allFinite(pos)).toBe(true);
      const a = pos.get('n0');
      const b = pos.get('n1');
      const dist = Math.hypot((a!.x - b!.x), (a!.y - b!.y));
      expect(dist).toBeGreaterThan(0);
    });
  });

  describe('scale', () => {
    it('handles a 200-node graph within budget', () => {
      const nodes = makeNodes(200);
      const edges = chainEdges(200);
      const start = Date.now();
      const pos = computeLayout(nodes, edges, { width: WIDTH, height: HEIGHT });
      const elapsed = Date.now() - start;
      expect(pos.size).toBe(200);
      expect(allFinite(pos)).toBe(true);
      expect(withinBounds(pos)).toBe(true);
      // Generous ceiling — this is a one-time layout, not a per-frame cost.
      expect(elapsed).toBeLessThan(5000);
    });
  });
});
