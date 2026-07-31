import * as React from 'react';
import { cn } from '@/renderer/lib/utils';

/**
 * Minimal scroll area without @radix-ui/react-scroll-area (not in approved
 * deps). Wraps children in a div with overflow:auto and themed scrollbars.
 * If a richer implementation is needed later, swap to the Radix primitive.
 */
const ScrollArea = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, children, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('relative overflow-auto', className)}
      {...props}
    >
      {children}
    </div>
  ),
);
ScrollArea.displayName = 'ScrollArea';

const ScrollBar: React.FC<React.HTMLAttributes<HTMLDivElement>> = () => null;
ScrollBar.displayName = 'ScrollBar';

export { ScrollArea, ScrollBar };
