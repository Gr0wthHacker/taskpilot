/**
 * Renders a markdown string with the GFM superset (tables, strikethrough,
 * task lists, autolinks) and a tightly whitelisted set of HTML tags. Raw
 * HTML passed through markdown is NOT supported on purpose — we render the
 * AST, not the raw input, so any `<script>` or `<iframe>` simply doesn't
 * make it to the DOM.
 *
 * Links open in the user's external browser via the preload bridge rather
 * than navigating the Electron window (which would replace the renderer).
 */

import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { cn } from '@/renderer/lib/utils';

interface MarkdownViewProps {
  source: string | null | undefined;
  className?: string;
  /**
   * When true, render with less vertical spacing — useful inside cards/rows.
   */
  compact?: boolean;
}

/**
 * Open the URL in the default browser via the Electron bridge. Falls back
 * to a regular `window.open` (in dev / browser) so the component still
 * works during `vite dev`.
 */
function openExternal(url: string): void {
  const bridge = (window as unknown as {
    taskpilot?: { openExternal?: (u: string) => Promise<unknown> };
  }).taskpilot;
  if (bridge?.openExternal) {
    void bridge.openExternal(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * Whitelist of allowed elements. Anything not in this map is filtered out
 * by react-markdown's `allowedElements` prop below; the component overrides
 * here drive the styling/behaviour for the ones that ARE allowed.
 */
const ALLOWED_ELEMENTS: string[] = [
  'p',
  'a',
  'strong',
  'em',
  'del',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'br',
  'img',
  'input', // for GFM task list checkboxes
];

const componentOverrides: Components = {
  a({ href, children, ...rest }) {
    const url = typeof href === 'string' ? href : '';
    return (
      <a
        {...rest}
        href={url}
        onClick={(e) => {
          e.preventDefault();
          if (url) openExternal(url);
        }}
        className="text-primary underline-offset-2 hover:underline"
      >
        {children}
      </a>
    );
  },
  code({ className, children, ...rest }) {
    const inline = !/language-/.test(className ?? '');
    if (inline) {
      return (
        <code
          {...rest}
          className="rounded bg-muted px-1 py-0.5 text-[0.85em] font-mono text-foreground"
        >
          {children}
        </code>
      );
    }
    return (
      <code
        {...rest}
        className={cn('font-mono text-[0.85em]', className)}
      >
        {children}
      </code>
    );
  },
  pre({ children, ...rest }) {
    return (
      <pre
        {...rest}
        className="overflow-auto rounded-md border border-border bg-muted/60 p-3 text-xs"
      >
        {children}
      </pre>
    );
  },
  table({ children, ...rest }) {
    return (
      <div className="overflow-x-auto">
        <table
          {...rest}
          className="my-2 w-full border-collapse text-sm"
        >
          {children}
        </table>
      </div>
    );
  },
  th({ children, ...rest }) {
    return (
      <th
        {...rest}
        className="border border-border bg-muted/40 px-2 py-1 text-left font-semibold"
      >
        {children}
      </th>
    );
  },
  td({ children, ...rest }) {
    return (
      <td {...rest} className="border border-border px-2 py-1">
        {children}
      </td>
    );
  },
  blockquote({ children, ...rest }) {
    return (
      <blockquote
        {...rest}
        className="border-l-2 border-border pl-3 text-muted-foreground"
      >
        {children}
      </blockquote>
    );
  },
  // Disable rendering of raw `<img>` from suspicious sources. Vite serves
  // app:// / file:// — anything else should also load via shell.openExternal.
  img(props) {
    const src = typeof props.src === 'string' ? props.src : '';
    if (!/^https?:\/\//i.test(src) && !/^data:image\//i.test(src)) {
      return null;
    }
    return (
      <img
        {...props}
        alt={props.alt ?? ''}
        className="max-w-full rounded-md border border-border"
      />
    );
  },
  input(props) {
    // GFM task list checkboxes — render as disabled to avoid letting users
    // think they're interactive.
    if (props.type === 'checkbox') {
      return (
        <input
          type="checkbox"
          checked={Boolean(props.checked)}
          readOnly
          disabled
          className="mr-1.5 align-middle"
        />
      );
    }
    return <input {...props} />;
  },
};

export function MarkdownView({
  source,
  className,
  compact,
}: MarkdownViewProps): JSX.Element | null {
  if (!source || source.trim().length === 0) return null;
  return (
    <div
      className={cn(
        'markdown-view text-sm leading-relaxed text-foreground',
        compact ? 'space-y-1.5' : 'space-y-2',
        '[&_h1]:mt-2 [&_h1]:text-lg [&_h1]:font-semibold',
        '[&_h2]:mt-2 [&_h2]:text-base [&_h2]:font-semibold',
        '[&_h3]:mt-2 [&_h3]:text-sm [&_h3]:font-semibold',
        '[&_ul]:ml-5 [&_ul]:list-disc [&_ol]:ml-5 [&_ol]:list-decimal',
        '[&_li]:my-0.5',
        '[&_hr]:my-3 [&_hr]:border-border',
        '[&_p]:my-0',
        className,
      )}
      aria-label="markdown-view"
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        allowedElements={ALLOWED_ELEMENTS}
        unwrapDisallowed
        skipHtml
        components={componentOverrides}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

export default MarkdownView;
