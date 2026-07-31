/**
 * A single edge in the task graph SVG (Wave 17).
 *
 * Styling encodes the edge kind:
 *   - parent    → solid slate line with an arrowhead (parent → child).
 *   - blocks    → red dashed line with an arrowhead.
 *   - related   → gray dotted line, no arrowhead (symmetric).
 *   - duplicate → purple dashed line with an arrowhead.
 *   - produces  → green solid line with an arrowhead (task → artifact).
 *   - member_of → amber dotted line (task → goal).
 *
 * The arrowhead is drawn via a shared `<marker>` defined once in GraphCanvas;
 * this component just references it by id per color.
 */

import type { GraphEdge as GraphEdgeData } from '@/shared/api-contract';

export interface EdgeStyle {
  color: string;
  dash?: string;
  /** Which arrow marker to point to, or null for no arrowhead. */
  marker: 'slate' | 'red' | 'purple' | 'green' | null;
}

export function edgeStyle(kind: GraphEdgeData['kind']): EdgeStyle {
  switch (kind) {
    case 'parent':
      return { color: '#64748b', marker: 'slate' };
    case 'blocks':
      return { color: '#ef4444', dash: '6 4', marker: 'red' };
    case 'related':
      return { color: '#94a3b8', dash: '2 4', marker: null };
    case 'duplicate':
      return { color: '#a855f7', dash: '5 3', marker: 'purple' };
    case 'produces':
      return { color: '#10b981', marker: 'green' };
    case 'member_of':
      return { color: '#f59e0b', dash: '2 4', marker: null };
    default:
      return { color: '#94a3b8', marker: null };
  }
}

export interface GraphEdgeProps {
  edge: GraphEdgeData;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Dim non-incident edges when a node is selected. */
  dimmed: boolean;
}

export function GraphEdge({
  edge,
  x1,
  y1,
  x2,
  y2,
  dimmed,
}: GraphEdgeProps): JSX.Element {
  const style = edgeStyle(edge.kind);
  return (
    <line
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      stroke={style.color}
      strokeWidth={1.5}
      strokeDasharray={style.dash}
      markerEnd={style.marker ? `url(#graph-arrow-${style.marker})` : undefined}
      opacity={dimmed ? 0.15 : 0.7}
      aria-label={`graph-edge-${edge.kind}`}
    />
  );
}

export default GraphEdge;
