/**
 * SVG graph canvas with pan + zoom (Wave 17).
 *
 * Renders a {@link GraphResponse} laid out by the hand-rolled force simulation
 * in `@/renderer/lib/force-layout`. The layout is memoized on the node/edge
 * identity so panning/zooming never re-runs the simulation.
 *
 * Interaction:
 *   - Drag the background → pan (updates the viewBox translation).
 *   - Mouse wheel → zoom toward the cursor (clamped 0.3×–3×).
 *   - Click a node → `onNodeClick` (the view decides navigate vs openExternal).
 *   - Hover a node → floating tooltip with label + status/kind.
 *
 * The whole scene lives inside a single `<g transform>` so pan/zoom is a cheap
 * transform update rather than a re-layout.
 */

import { useMemo, useRef, useState, useCallback } from 'react';

import { computeLayout, type Point } from '@/renderer/lib/force-layout';
import type {
  GraphNode as GraphNodeData,
  GraphResponse,
} from '@/shared/api-contract';

import { GraphEdge } from './GraphEdge';
import { GraphNode } from './GraphNode';

const LAYOUT_WIDTH = 1200;
const LAYOUT_HEIGHT = 800;
const MIN_SCALE = 0.3;
const MAX_SCALE = 3;

interface ViewTransform {
  scale: number;
  tx: number;
  ty: number;
}

export interface GraphCanvasProps {
  graph: GraphResponse;
  onNodeClick: (node: GraphNodeData) => void;
}

export function GraphCanvas({ graph, onNodeClick }: GraphCanvasProps): JSX.Element {
  // Memoize the layout on the structural identity of the graph — a stable key
  // built from node ids + edge endpoints. Pan/zoom never invalidates this.
  const layoutKey = useMemo(() => {
    const nodeKey = graph.nodes.map((n) => n.id).join(',');
    const edgeKey = graph.edges
      .map((e) => `${e.kind}:${e.source}>${e.target}`)
      .join(',');
    return `${nodeKey}|${edgeKey}`;
  }, [graph]);

  const positions = useMemo<Map<string, Point>>(
    () =>
      computeLayout(graph.nodes, graph.edges, {
        width: LAYOUT_WIDTH,
        height: LAYOUT_HEIGHT,
      }),
    // layoutKey captures the structural identity; recompute only when it
    // changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layoutKey],
  );

  const [view, setView] = useState<ViewTransform>({ scale: 1, tx: 0, ty: 0 });
  const [hovered, setHovered] = useState<GraphNodeData | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(
    null,
  );

  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragState = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    startTx: number;
    startTy: number;
    moved: boolean;
  }>({ active: false, startX: 0, startY: 0, startTx: 0, startTy: 0, moved: false });

  const handleWheel = useCallback((e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    setView((prev) => {
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const nextScale = clamp(prev.scale * factor, MIN_SCALE, MAX_SCALE);
      const ratio = nextScale / prev.scale;
      // Zoom toward the cursor: keep the point under the mouse fixed.
      const tx = mx - ratio * (mx - prev.tx);
      const ty = my - ratio * (my - prev.ty);
      return { scale: nextScale, tx, ty };
    });
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      // Only start a pan on a background press (not on a node).
      const target = e.target as Element;
      if (target.closest('[role="button"]')) return;
      dragState.current = {
        active: true,
        startX: e.clientX,
        startY: e.clientY,
        startTx: view.tx,
        startTy: view.ty,
        moved: false,
      };
      (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
    },
    [view.tx, view.ty],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const drag = dragState.current;
      if (drag.active) {
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true;
        setView((prev) => ({ ...prev, tx: drag.startTx + dx, ty: drag.startTy + dy }));
      }
      if (hovered) {
        const svg = svgRef.current;
        if (svg) {
          const rect = svg.getBoundingClientRect();
          setTooltipPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
        }
      }
    },
    [hovered],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      dragState.current.active = false;
      try {
        (e.currentTarget as SVGSVGElement).releasePointerCapture(e.pointerId);
      } catch {
        /* pointer already released */
      }
    },
    [],
  );

  const handleNodeClick = useCallback(
    (node: GraphNodeData) => {
      setSelected(node.id);
      onNodeClick(node);
    },
    [onNodeClick],
  );

  const handleNodeHover = useCallback((node: GraphNodeData | null) => {
    setHovered(node);
    if (!node) setTooltipPos(null);
  }, []);

  // Build a quick lookup so edges can find their endpoint positions + decide
  // dimming relative to the selected node.
  const incidentEdges = useMemo(() => {
    if (!selected) return null;
    const set = new Set<string>();
    graph.edges.forEach((e, i) => {
      if (e.source === selected || e.target === selected) set.add(String(i));
    });
    return set;
  }, [selected, graph.edges]);

  return (
    <div className="relative h-full w-full overflow-hidden rounded-lg border border-border bg-card">
      <svg
        ref={svgRef}
        className="h-full w-full touch-none"
        role="img"
        aria-label="task-graph"
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onClick={(e) => {
          // Background click (not a node, not a pan) clears selection.
          const target = e.target as Element;
          if (!target.closest('[role="button"]') && !dragState.current.moved) {
            setSelected(null);
          }
        }}
      >
        <defs>
          {(
            [
              ['slate', '#64748b'],
              ['red', '#ef4444'],
              ['purple', '#a855f7'],
              ['green', '#10b981'],
            ] as const
          ).map(([name, color]) => (
            <marker
              key={name}
              id={`graph-arrow-${name}`}
              viewBox="0 0 10 10"
              refX="18"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
            </marker>
          ))}
        </defs>

        <g transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}>
          {/* Edges first so nodes render on top. */}
          {graph.edges.map((edge, i) => {
            const a = positions.get(edge.source);
            const b = positions.get(edge.target);
            if (!a || !b) return null;
            const dimmed = incidentEdges !== null && !incidentEdges.has(String(i));
            return (
              <GraphEdge
                key={`${edge.kind}-${edge.source}-${edge.target}-${i}`}
                edge={edge}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                dimmed={dimmed}
              />
            );
          })}
          {graph.nodes.map((node) => {
            const p = positions.get(node.id);
            if (!p) return null;
            return (
              <GraphNode
                key={node.id}
                node={node}
                x={p.x}
                y={p.y}
                selected={selected === node.id}
                scale={view.scale}
                onClick={handleNodeClick}
                onHover={handleNodeHover}
              />
            );
          })}
        </g>
      </svg>

      {/* Zoom controls */}
      <div className="absolute bottom-3 right-3 flex flex-col gap-1">
        <button
          type="button"
          aria-label="graph-zoom-in"
          className="flex h-7 w-7 items-center justify-center rounded border border-border bg-background text-sm shadow-sm hover:bg-accent"
          onClick={() =>
            setView((p) => ({ ...p, scale: clamp(p.scale * 1.2, MIN_SCALE, MAX_SCALE) }))
          }
        >
          +
        </button>
        <button
          type="button"
          aria-label="graph-zoom-out"
          className="flex h-7 w-7 items-center justify-center rounded border border-border bg-background text-sm shadow-sm hover:bg-accent"
          onClick={() =>
            setView((p) => ({ ...p, scale: clamp(p.scale / 1.2, MIN_SCALE, MAX_SCALE) }))
          }
        >
          −
        </button>
        <button
          type="button"
          aria-label="graph-zoom-reset"
          className="flex h-7 w-7 items-center justify-center rounded border border-border bg-background text-xs shadow-sm hover:bg-accent"
          onClick={() => setView({ scale: 1, tx: 0, ty: 0 })}
        >
          ⌂
        </button>
      </div>

      {/* Hover tooltip */}
      {hovered && tooltipPos && (
        <div
          className="pointer-events-none absolute z-10 max-w-xs rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
          style={{ left: tooltipPos.x + 12, top: tooltipPos.y + 12 }}
          aria-label="graph-tooltip"
        >
          <div className="font-medium">{hovered.label}</div>
          <div className="text-muted-foreground">
            {hovered.kind === 'task'
              ? `task · ${hovered.status ?? 'unknown'}`
              : hovered.kind}
          </div>
        </div>
      )}
    </div>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export default GraphCanvas;
