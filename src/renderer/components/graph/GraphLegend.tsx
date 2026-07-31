/**
 * Graph legend (Wave 17).
 *
 * A static key explaining the node colors (status), node shapes (kind), and
 * edge styles (relationship). Rendered alongside the canvas so the user can
 * decode the graph without trial and error.
 */

import { nodeColor } from './GraphNode';
import { edgeStyle } from './GraphEdge';
import type { GraphEdge, GraphNode } from '@/shared/api-contract';

const STATUS_SWATCHES: Array<{ label: string; node: GraphNode }> = [
  { label: 'Open (inbox/queued/in progress)', node: { id: 's1', kind: 'task', label: '', status: 'queued' } },
  { label: 'Blocked', node: { id: 's2', kind: 'task', label: '', status: 'blocked' } },
  { label: 'Done', node: { id: 's3', kind: 'task', label: '', status: 'done' } },
  { label: 'Failed', node: { id: 's4', kind: 'task', label: '', status: 'failed' } },
];

const SHAPE_KEY: Array<{ label: string; kind: GraphNode['kind'] }> = [
  { label: 'Task (circle)', kind: 'task' },
  { label: 'PR / issue (diamond)', kind: 'pr' },
  { label: 'Event (square)', kind: 'event' },
  { label: 'Goal (hexagon)', kind: 'goal' },
];

const EDGE_KEY: Array<{ label: string; kind: GraphEdge['kind'] }> = [
  { label: 'Parent → child', kind: 'parent' },
  { label: 'Blocks', kind: 'blocks' },
  { label: 'Related', kind: 'related' },
  { label: 'Duplicate of', kind: 'duplicate' },
  { label: 'Produces artifact', kind: 'produces' },
  { label: 'Member of goal', kind: 'member_of' },
];

/** A tiny SVG glyph matching the canvas node shape, scaled to legend size. */
function ShapeGlyph({ kind }: { kind: GraphNode['kind'] }): JSX.Element {
  const fill = '#64748b';
  const stroke = '#ffffff';
  switch (kind) {
    case 'task':
      return (
        <svg width="16" height="16" viewBox="-8 -8 16 16">
          <circle r="6" fill={fill} stroke={stroke} strokeWidth="1.2" />
        </svg>
      );
    case 'pr':
    case 'issue':
      return (
        <svg width="16" height="16" viewBox="-8 -8 16 16">
          <path d="M 0 -7 L 7 0 L 0 7 L -7 0 Z" fill={fill} stroke={stroke} strokeWidth="1.2" />
        </svg>
      );
    case 'event':
      return (
        <svg width="16" height="16" viewBox="-8 -8 16 16">
          <rect x="-6" y="-6" width="12" height="12" rx="1.5" fill={fill} stroke={stroke} strokeWidth="1.2" />
        </svg>
      );
    case 'goal':
      return (
        <svg width="16" height="16" viewBox="-8 -8 16 16">
          <polygon points="7,0 3.5,6 -3.5,6 -7,0 -3.5,-6 3.5,-6" fill={fill} stroke={stroke} strokeWidth="1.2" />
        </svg>
      );
    default:
      return (
        <svg width="16" height="16" viewBox="-8 -8 16 16">
          <circle r="6" fill={fill} stroke={stroke} strokeWidth="1.2" />
        </svg>
      );
  }
}

export function GraphLegend(): JSX.Element {
  return (
    <aside
      className="hidden w-56 shrink-0 overflow-auto rounded-lg border border-border bg-card p-3 text-xs lg:block"
      aria-label="graph-legend"
    >
      <Section title="Status (color)">
        {STATUS_SWATCHES.map((s) => (
          <div key={s.label} className="flex items-center gap-2 py-0.5">
            <span
              className="inline-block h-3 w-3 rounded-full"
              style={{ backgroundColor: nodeColor(s.node) }}
            />
            <span className="text-muted-foreground">{s.label}</span>
          </div>
        ))}
      </Section>

      <Section title="Kind (shape)">
        {SHAPE_KEY.map((s) => (
          <div key={s.label} className="flex items-center gap-2 py-0.5">
            <ShapeGlyph kind={s.kind} />
            <span className="text-muted-foreground">{s.label}</span>
          </div>
        ))}
      </Section>

      <Section title="Relationships (edges)">
        {EDGE_KEY.map((e) => {
          const style = edgeStyle(e.kind);
          return (
            <div key={e.label} className="flex items-center gap-2 py-0.5">
              <svg width="28" height="10" viewBox="0 0 28 10">
                <line
                  x1="1"
                  y1="5"
                  x2="27"
                  y2="5"
                  stroke={style.color}
                  strokeWidth="2"
                  strokeDasharray={style.dash}
                />
              </svg>
              <span className="text-muted-foreground">{e.label}</span>
            </div>
          );
        })}
      </Section>
    </aside>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  );
}

export default GraphLegend;
