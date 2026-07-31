/**
 * Quick-capture form.
 *
 * Single-line title + optional description textarea. Enter (when not in the
 * textarea) or Cmd/Ctrl-Enter submits. Esc dismisses via the preload bridge.
 *
 * The capture window is a SEPARATE BrowserWindow from the main app — this
 * component does not get React Query, the router, or shadcn UI, and it
 * mustn't import from `@/renderer/...` because the capture Vite config has
 * a minimal alias surface. Keep the imports tight.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

type SubmitResult =
  | { ok: true; task_id: string; title: string }
  | { ok: false; message: string };

interface CaptureBridge {
  captureSubmit?: (input: {
    title: string;
    description?: string | null;
  }) => Promise<SubmitResult>;
  captureDismiss?: () => Promise<{ ok: boolean; message?: string }>;
  onCaptureFocus?: (cb: () => void) => () => void;
}

function readBridge(): CaptureBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { taskpilot?: CaptureBridge }).taskpilot;
}

export function CaptureWindow(): JSX.Element {
  const titleRef = useRef<HTMLInputElement | null>(null);
  const descRef = useRef<HTMLTextAreaElement | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Reveal the description textarea on demand (Tab from the title field).
  const [showDesc, setShowDesc] = useState(false);

  /* ------------------ Focus + reset on (re)show ----------------------- */

  const focusInput = useCallback((): void => {
    setTitle('');
    setDescription('');
    setError(null);
    setShowDesc(false);
    // Defer so React commits the cleared input before we focus.
    setTimeout(() => {
      titleRef.current?.focus();
      titleRef.current?.select();
    }, 0);
  }, []);

  useEffect(() => {
    // First mount.
    focusInput();
  }, [focusInput]);

  useEffect(() => {
    // Main process pushes `tp:capture:focus` each time the window is
    // re-shown so we can clear stale input and refocus.
    const bridge = readBridge();
    if (!bridge?.onCaptureFocus) return undefined;
    const off = bridge.onCaptureFocus(focusInput);
    return off;
  }, [focusInput]);

  /* ------------------ Dismiss / submit -------------------------------- */

  const dismiss = useCallback((): void => {
    const bridge = readBridge();
    if (bridge?.captureDismiss) {
      void bridge.captureDismiss();
    } else {
      // Browser fallback (dev preview).
      window.close();
    }
  }, []);

  const submit = useCallback(async (): Promise<void> => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const bridge = readBridge();
      if (!bridge?.captureSubmit) {
        setError('IPC bridge unavailable');
        return;
      }
      const result = await bridge.captureSubmit({
        title: trimmedTitle,
        description: description.trim().length > 0 ? description.trim() : null,
      });
      if (result.ok) {
        dismiss();
      } else {
        setError(result.message || 'Failed to capture');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unknown error');
    } finally {
      setSubmitting(false);
    }
  }, [title, description, submitting, dismiss]);

  /* ------------------ Keyboard handling ------------------------------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        dismiss();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dismiss]);

  const onTitleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void submit();
    } else if (e.key === 'Tab' && !e.shiftKey) {
      // Reveal the description field on first Tab.
      if (!showDesc) {
        e.preventDefault();
        setShowDesc(true);
        setTimeout(() => descRef.current?.focus(), 0);
      }
    }
  };

  const onDescKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Cmd-Enter (Mac) / Ctrl-Enter (everywhere) submits from textarea.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      dismiss();
    }
  };

  return (
    <div className="capture-shell" aria-label="quick-capture-window">
      <form
        className="capture-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          ref={titleRef}
          aria-label="quick-capture-input"
          className="capture-input"
          type="text"
          placeholder="What needs doing?"
          value={title}
          autoFocus
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={onTitleKeyDown}
          maxLength={500}
          disabled={submitting}
        />
        {showDesc && (
          <textarea
            ref={descRef}
            aria-label="quick-capture-description"
            className="capture-textarea"
            placeholder="Notes (optional). Cmd/Ctrl-Enter to save."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={onDescKeyDown}
            maxLength={50_000}
            disabled={submitting}
            rows={2}
          />
        )}
        <div className="capture-footer">
          <span className="capture-hint">
            {showDesc ? 'Cmd/Ctrl-Enter to save · Esc to cancel' : 'Enter to save · Tab for notes · Esc to cancel'}
          </span>
          <button
            type="submit"
            aria-label="quick-capture-submit"
            className="capture-submit"
            disabled={submitting || title.trim().length === 0}
          >
            {submitting ? 'Saving…' : 'Save'}
          </button>
        </div>
        {error && (
          <p role="alert" className="capture-error" aria-label="quick-capture-error">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}

export default CaptureWindow;
