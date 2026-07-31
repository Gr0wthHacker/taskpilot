/**
 * Top-level error boundary. Wraps the RouterProvider so a runtime crash in
 * any view surfaces as a recoverable error screen instead of a blank
 * window. The "Reload" button calls `window.location.reload()` which is
 * cheap (the renderer is a single Vite bundle) and resets the React tree
 * along with any client-side state that was driving the crash.
 *
 * We use a class component because `react-error-boundary` isn't in the
 * approved dependency list and a 30-line class does the job.
 */

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to the renderer console so devs can grab a stack trace from
    // DevTools. We intentionally don't ship this to the server — the
    // operator can reproduce locally if a real crash sneaks through.
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary] render error:', error, info);
  }

  private handleReload = (): void => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        className="flex h-screen w-screen items-center justify-center bg-background p-8 text-foreground"
        aria-label="app-error-boundary"
      >
        <div className="max-w-lg space-y-4 rounded-lg border border-destructive/40 bg-destructive/5 p-6">
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="text-sm text-muted-foreground">
            The app hit an unexpected error and stopped rendering. Reload to
            try again — if it keeps happening, the renderer console has the
            full stack trace.
          </p>
          <pre className="max-h-48 overflow-auto rounded-md bg-muted/40 p-3 text-[11px] leading-relaxed">
            {error.message || String(error)}
          </pre>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={this.handleReload}
              className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
