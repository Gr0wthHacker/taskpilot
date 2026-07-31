/**
 * A single node in the task graph SVG (Wave 17).
 *
 * Shape encodes the node KIND, fill encodes the task STATUS:
 *   - task   → circle
 *   - pr     → diamond
 *   - issue  → diamond (outlined differently from PR via stroke)
 *   - event  → square
 *   - goal   → hexagon
 *
 * Status color (task nodes): inbox/queued/in_progress = blue, done = green,
 * failed = red, blocked = amber. Artifact + goal nodes use a neutral slate so
 * they read as "not a task". All colors are plain hex (SVG fill) rather than
 * Tailwind classes because SVG `fill` doesn't pick up utility classes.
 */

import type { GraphNode as GraphNodeData } from '@/shared/api-contract';

export const NODE_RADIUS = 9;

/** Fill color for a node, keyed off kind + status. */
export function nodeColor(node: GraphNodeData): string {
  if (node.kind !== 'task') {
    // Artifacts + goals: neutral slate, slightly distinct per kind.
    switch (node.kind) {
      case 'pr':
        return '#8b5cf6'; // violet
      case 'issue':
        return '#6366f1'; // indigo
      case 'event':
        return '#0ea5e9'; // sky
      case 'goal':
        return '#f59e0b'; // amber-gold
      default:
        return '#94a3b8';
    }
  }
  switch (node.status) {
    case 'done':
      return '#10b981'; // emerald
    case 'failed':
      return '#ef4444'; // red
    case 'blocked':
      return '#f59e0b'; // amber
    case 'inbox':
    case 'queued':
    case 'in_progress':
      return '#3b82f6'; // blue
    case 'archived':
      return '#94a3b8'; // slate
    default:
      return '#3b82f6';
  }
}

/**
 * Build the SVG element(s) for a node shape centered at the origin. Returned
 * as a fragment of the `<path>`/`<circle>`/`<rect>` so the canvas can position
 * via a `<g transform>`.
 */
function NodeShape({
  kind,
  fill,
  selected,
}: {
  kind: GraphNodeData['kind'];
  fill: string;
  selected: boolean;
}): JSX.Element {
  const stroke = selected ? '#0f172a' : '#ffffff';
  const strokeWidth = selected ? 2.5 : 1.5;
  const r = NODE_RADIUS;

  switch (kind) {
    case 'task':
      return <circle r={r} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />;
    case 'pr':
    case 'issue': {
      // Diamond: a square rotated 45°.
      const d = r * 1.25;
      return (
        <path
          d={`M 0 ${-d} L ${d} 0 L 0 ${d} L ${-d} 0 Z`}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      );
    }
    case 'event': {
      const s = r * 1.6;
      return (
        <rect
          x={-s / 2}
          y={-s / 2}
          width={s}
          height={s}
          rx={1.5}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      );
    }
    case 'goal': {
      // Hexagon (flat-top).
      const a = r * 1.3;
      const pts: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const angle = (Math.PI / 3) * i;
        pts.push(`${(a * Math.cos(angle)).toFixed(2)},${(a * Math.sin(angle)).toFixed(2)}`);
      }
      return (
        <polygon
          points={pts.join(' ')}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      );
    }
    default:
      return <circle r={r} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />;
  }
}

export interface GraphNodeProps {
  node: GraphNodeData;
  x: number;
  y: number;
  selected: boolean;
  /** Current zoom scale — used to keep label text legible. */
  scale: number;
  onClick: (node: GraphNodeData) => void;
  onHover: (node: GraphNodeData | null) => void;
}

export function GraphNode({
  node,
  x,
  y,
  selected,
  scale,
  onClick,
  onHover,
}: GraphNodeProps): JSX.Element {
  const fill = nodeColor(node);
  // Truncate long labels so they don't blow out the canvas.
  const label = node.label.length > 28 ? `${node.label.slice(0, 27)}…` : node.label;
  // Counter-scale the font so labels stay ~11px on screen regardless of zoom,
  // clamped so they don't vanish or dominate.
  const fontSize = Math.min(16, Math.max(8, 11 / scale));

  return (
    <g
      transform={`translate(${x} ${y})`}
      className="cursor-pointer"
      role="button"
      tabIndex={0}
      aria-label={`graph-node-${node.id}`}
      onClick={(e) => {
        e.stopPropagation();
        onClick(node);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick(node);
        }
      }}
      onMouseEnter={() => onHover(node)}
      onMouseLeave={() => onHover(null)}
    >
      <NodeShape kind={node.kind} fill={fill} selected={selected} />
      <text
        x={0}
        y={NODE_RADIUS + fontSize + 2}
        textAnchor="middle"
        fontSize={fontSize}
        className="fill-foreground"
        style={{ pointerEvents: 'none', userSelect: 'none' }}
      >
        {label}
      </text>
    </g>
  );
}

export default GraphNode;
