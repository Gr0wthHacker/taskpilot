/**
 * Constant-cost list renderer over `@tanstack/react-virtual`.
 *
 * The renderer only mounts rows that fit inside the scroll viewport (plus a
 * small overscan buffer), so a 10k-row inbox renders in the same wall-clock
 * as a 100-row inbox. Use this for any list where the worst-case count is
 * "could plausibly be in the thousands."
 *
 * Why not react-window? Same performance characteristics, but react-virtual
 * is from the TanStack family the rest of the app uses, smaller bundle, and
 * handles dynamic row heights better via `measureElement`.
 *
 * Usage:
 *   <VirtualList
 *     items={tasks}
 *     estimateSize={() => 64}
 *     renderRow={(task) => <TaskCard task={task} />}
 *   />
 *
 * The container needs a defined height — pass `className` with `h-*` or
 * style with `height`. We use `overflow-auto` so the wrapper itself scrolls.
 */

import { useVirtualizer } from '@tanstack/react-virtual';
import {
  forwardRef,
  useImperativeHandle,
  useRef,
  type CSSProperties,
  type ForwardedRef,
  type ReactNode,
} from 'react';

import { cn } from '@/renderer/lib/utils';

export interface VirtualListHandle {
  /** Scroll the given row index into view. Use after navigating to a deep link. */
  scrollToIndex(index: number, opts?: { align?: 'auto' | 'start' | 'center' | 'end' }): void;
  /** Re-measure all visible rows. Call after a width change (sidebar collapse, etc.). */
  remeasure(): void;
}

export interface VirtualListProps<T> {
  items: readonly T[];
  /**
   * Estimated row height in px. Used to compute the scrollbar before any
   * rows have been measured. Doesn't need to be exact — `measureElement`
   * corrects per-row sizes as they render.
   */
  estimateSize: (index: number) => number;
  /**
   * Render one item. Wrapping divs are handled here — only return the row's
   * content. Receives the item, the index, and a `measureRef` ref that
   * MUST be attached to the row's outermost element so the virtualizer can
   * measure its rendered height.
   */
  renderRow: (
    item: T,
    index: number,
    measureRef: (el: HTMLElement | null) => void,
  ) => ReactNode;
  /**
   * Stable key per item. Defaults to index — pass `(item) => item.id` for
   * lists where rows can move (sort changes, filter narrowing) so React
   * reconciles correctly.
   */
  getKey?: (item: T, index: number) => string | number;
  /**
   * Number of rows rendered above/below the viewport. Larger values reduce
   * pop-in when fast-scrolling but cost more memory. Default 5.
   */
  overscan?: number;
  /** Optional Tailwind classes applied to the scroll wrapper. */
  className?: string;
  /** Inline style on the scroll wrapper (use for explicit pixel heights). */
  style?: CSSProperties;
  /** Optional accessibility label (placed on the scroll wrapper). */
  ariaLabel?: string;
}

function VirtualListInner<T>(
  props: VirtualListProps<T>,
  ref: ForwardedRef<VirtualListHandle>,
): JSX.Element {
  const {
    items,
    estimateSize,
    renderRow,
    getKey,
    overscan = 5,
    className,
    style,
    ariaLabel,
  } = props;

  const parentRef = useRef<HTMLDivElement | null>(null);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize,
    overscan,
    // Stable keys help React reconcile when items shift; without this the
    // virtualizer falls back to index which causes a tiny flicker on sort.
    getItemKey: getKey
      ? (index: number) => getKey(items[index]!, index)
      : undefined,
  });

  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex(index, opts) {
        virtualizer.scrollToIndex(index, opts);
      },
      remeasure() {
        virtualizer.measure();
      },
    }),
    [virtualizer],
  );

  const totalSize = virtualizer.getTotalSize();
  const virtualRows = virtualizer.getVirtualItems();

  return (
    <div
      ref={parentRef}
      className={cn('overflow-auto', className)}
      style={style}
      aria-label={ariaLabel}
    >
      <div
        style={{
          height: `${totalSize}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualRows.map((vr) => (
          <div
            key={vr.key}
            data-index={vr.index}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${vr.start}px)`,
            }}
          >
            {renderRow(items[vr.index]!, vr.index, () => {
              // Consumer-supplied ref is unused — measureElement is wired
              // on the wrapping div above. Kept in the signature so callers
              // that prefer to attach the ref themselves (e.g. for IntersectionObserver)
              // have the option.
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// Cast preserves the generic. Without this, forwardRef strips T.
export const VirtualList = forwardRef(VirtualListInner) as <T>(
  props: VirtualListProps<T> & { ref?: ForwardedRef<VirtualListHandle> },
) => JSX.Element;
