/**
 * Markdown editor with a toolbar + live preview toggle.
 *
 * Drop-in replacement for the plain `<Textarea>` used by NewTaskDialog and
 * TaskDetail's description editor. Toolbar buttons wrap the current
 * selection (or the line in the case of lists/headings) with the appropriate
 * markdown syntax; preview mode swaps in the existing `MarkdownView`
 * component so the rendering is identical to read mode elsewhere in the app.
 *
 * Shortcuts (when focus is inside the textarea):
 *   - Ctrl/Cmd-B → bold
 *   - Ctrl/Cmd-I → italic
 *   - Ctrl/Cmd-K → link (prompts for URL)
 *
 * The component is uncontrolled-style: the parent owns `value` and receives
 * change/blur callbacks. Tab is allowed to leave the textarea so keyboard
 * users can move on; preview toggle is a separate button.
 */

import {
  Bold,
  Code,
  Eye,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  PencilLine,
} from 'lucide-react';
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import { MarkdownView } from '@/renderer/components/shared/MarkdownView';
import { Button } from '@/renderer/components/ui/button';
import { Textarea } from '@/renderer/components/ui/textarea';
import { cn } from '@/renderer/lib/utils';

export interface MarkdownEditorHandle {
  focus: () => void;
}

interface MarkdownEditorProps {
  value: string;
  onChange: (next: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  rows?: number;
  /** Override the textarea's aria-label. Defaults to "markdown-editor". */
  ariaLabel?: string;
  /** Optional id wired onto the textarea — handy for label association. */
  id?: string;
  className?: string;
  /** When set, start the editor in preview mode (read-only render). */
  initialPreview?: boolean;
  /** Disable preview toggle (useful when the parent already shows a preview). */
  hidePreviewToggle?: boolean;
  autoFocus?: boolean;
}

interface ToolbarSpec {
  ariaLabel: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  apply: (
    api: EditorApi,
  ) => Promise<void> | void;
}

interface EditorApi {
  /** Wrap the current selection with `before`/`after`. If nothing is
   *  selected, the cursor lands between the markers and the caller's
   *  `placeholder` is inserted as a hint. */
  wrap: (before: string, after: string, placeholder?: string) => void;
  /** Prefix every line in the current selection (or the cursor line if no
   *  selection) with `prefix`. Empty prefixes are skipped. */
  linePrefix: (prefix: string) => void;
  /** Insert `text` at the cursor / replace selection with `text`. */
  insert: (text: string) => void;
  /** Show a prompt for a URL; returns the trimmed value or null on cancel. */
  promptUrl: () => string | null;
}

function buildApi(
  textarea: HTMLTextAreaElement,
  value: string,
  emit: (next: string, selStart: number, selEnd: number) => void,
): EditorApi {
  const { selectionStart, selectionEnd } = textarea;

  const wrap = (before: string, after: string, placeholder = ''): void => {
    const selected = value.slice(selectionStart, selectionEnd);
    const body = selected.length > 0 ? selected : placeholder;
    const next =
      value.slice(0, selectionStart) +
      before +
      body +
      after +
      value.slice(selectionEnd);
    const cursor = selectionStart + before.length;
    emit(next, cursor, cursor + body.length);
  };

  const linePrefix = (prefix: string): void => {
    if (prefix.length === 0) return;
    // Expand to whole lines containing the selection.
    const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
    let lineEnd = value.indexOf('\n', selectionEnd);
    if (lineEnd === -1) lineEnd = value.length;
    const block = value.slice(lineStart, lineEnd);
    const updated = block
      .split('\n')
      .map((line) => (line.length === 0 ? line : `${prefix}${line}`))
      .join('\n');
    const next =
      value.slice(0, lineStart) + updated + value.slice(lineEnd);
    const deltaEnd = updated.length - block.length;
    emit(next, lineStart, lineEnd + deltaEnd);
  };

  const insert = (text: string): void => {
    const next =
      value.slice(0, selectionStart) + text + value.slice(selectionEnd);
    const cursor = selectionStart + text.length;
    emit(next, cursor, cursor);
  };

  const promptUrl = (): string | null => {
    if (typeof window === 'undefined') return null;
    const raw = window.prompt('Link URL', 'https://');
    if (raw === null) return null;
    const trimmed = raw.trim();
    return trimmed.length === 0 ? null : trimmed;
  };

  return { wrap, linePrefix, insert, promptUrl };
}

const TOOLBAR: ToolbarSpec[] = [
  {
    ariaLabel: 'md-bold',
    icon: Bold,
    title: 'Bold (Ctrl/Cmd-B)',
    apply: (api) => api.wrap('**', '**', 'bold'),
  },
  {
    ariaLabel: 'md-italic',
    icon: Italic,
    title: 'Italic (Ctrl/Cmd-I)',
    apply: (api) => api.wrap('*', '*', 'italic'),
  },
  {
    ariaLabel: 'md-link',
    icon: LinkIcon,
    title: 'Link (Ctrl/Cmd-K)',
    apply: (api) => {
      const url = api.promptUrl();
      if (!url) return;
      api.wrap('[', `](${url})`, 'link text');
    },
  },
  {
    ariaLabel: 'md-bullet-list',
    icon: List,
    title: 'Bulleted list',
    apply: (api) => api.linePrefix('- '),
  },
  {
    ariaLabel: 'md-ordered-list',
    icon: ListOrdered,
    title: 'Numbered list',
    apply: (api) => api.linePrefix('1. '),
  },
  {
    ariaLabel: 'md-code',
    icon: Code,
    title: 'Code',
    apply: (api) => api.wrap('`', '`', 'code'),
  },
  {
    ariaLabel: 'md-h1',
    icon: Heading1,
    title: 'Heading 1',
    apply: (api) => api.linePrefix('# '),
  },
  {
    ariaLabel: 'md-h2',
    icon: Heading2,
    title: 'Heading 2',
    apply: (api) => api.linePrefix('## '),
  },
  {
    ariaLabel: 'md-h3',
    icon: Heading3,
    title: 'Heading 3',
    apply: (api) => api.linePrefix('### '),
  },
];

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
  function MarkdownEditor(
    {
      value,
      onChange,
      onBlur,
      placeholder,
      rows = 6,
      ariaLabel = 'markdown-editor',
      id,
      className,
      initialPreview = false,
      hidePreviewToggle = false,
      autoFocus = false,
    },
    ref,
  ): JSX.Element {
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const [preview, setPreview] = useState(initialPreview);

    useImperativeHandle(ref, () => ({
      focus: () => textareaRef.current?.focus(),
    }));

    const emit = useCallback(
      (next: string, selStart: number, selEnd: number) => {
        onChange(next);
        // Restore selection after React re-renders the textarea.
        queueMicrotask(() => {
          const el = textareaRef.current;
          if (!el) return;
          el.focus();
          el.setSelectionRange(selStart, selEnd);
        });
      },
      [onChange],
    );

    const runAction = useCallback(
      (action: ToolbarSpec['apply']) => {
        const el = textareaRef.current;
        if (!el) return;
        const api = buildApi(el, value, emit);
        void action(api);
      },
      [emit, value],
    );

    const handleKeyDown = (
      e: ReactKeyboardEvent<HTMLTextAreaElement>,
    ): void => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === 'b' || e.key === 'B') {
        e.preventDefault();
        runAction(TOOLBAR[0]!.apply);
        return;
      }
      if (e.key === 'i' || e.key === 'I') {
        e.preventDefault();
        runAction(TOOLBAR[1]!.apply);
        return;
      }
      if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        runAction(TOOLBAR[2]!.apply);
      }
    };

    return (
      <div
        className={cn(
          'rounded-md border border-border bg-background',
          className,
        )}
        aria-label={ariaLabel}
      >
        <div
          className="flex flex-wrap items-center gap-0.5 border-b border-border bg-muted/30 px-1 py-1"
          role="toolbar"
          aria-label="markdown-editor-toolbar"
        >
          {TOOLBAR.map((tool) => {
            const Icon = tool.icon;
            return (
              <Button
                key={tool.ariaLabel}
                type="button"
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                title={tool.title}
                aria-label={tool.ariaLabel}
                disabled={preview}
                onClick={(e) => {
                  // Don't steal focus on Mouse-down → keep selection.
                  e.preventDefault();
                  runAction(tool.apply);
                }}
                onMouseDown={(e) => e.preventDefault()}
              >
                <Icon className="h-3.5 w-3.5" />
              </Button>
            );
          })}

          {!hidePreviewToggle && (
            <Button
              type="button"
              size="sm"
              variant={preview ? 'default' : 'ghost'}
              className="ml-auto h-7 px-2 text-xs"
              onClick={() => setPreview((p) => !p)}
              aria-label="md-preview-toggle"
              aria-pressed={preview}
            >
              {preview ? (
                <>
                  <PencilLine className="mr-1 h-3 w-3" />
                  Edit
                </>
              ) : (
                <>
                  <Eye className="mr-1 h-3 w-3" />
                  Preview
                </>
              )}
            </Button>
          )}
        </div>

        {preview ? (
          <div
            className="min-h-[6rem] px-3 py-2"
            aria-label="markdown-editor-preview"
          >
            {value.trim().length === 0 ? (
              <p className="text-xs italic text-muted-foreground">
                Nothing to preview yet.
              </p>
            ) : (
              <MarkdownView source={value} />
            )}
          </div>
        ) : (
          <Textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onBlur}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            rows={rows}
            id={id}
            autoFocus={autoFocus}
            aria-label={`${ariaLabel}-input`}
            className="rounded-none border-0 bg-transparent shadow-none focus-visible:ring-0"
          />
        )}
      </div>
    );
  },
);

export default MarkdownEditor;
