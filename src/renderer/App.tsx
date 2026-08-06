import { QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { RouterProvider } from 'react-router-dom';
import { queryClient, queryKeys, useApiEventStream } from './lib/query';
import { router } from './router';
import { Toaster } from './components/ui/toaster';
import { useToast } from './components/ui/use-toast';
import { ErrorBoundary } from './components/ErrorBoundary';
import {
  KeyboardShortcutsProvider,
  NEW_TASK_EVENT,
  useKeyboardShortcuts,
} from './components/KeyboardShortcutsProvider';
import { CommandPalette } from './components/CommandPalette';
import { ShortcutsHelp } from './components/ShortcutsHelp';
import { SuggestionToast } from './components/Observer/SuggestionToast';
import { MorningBriefing } from './components/Observer/MorningBriefing';
import { SuggestionsSidebar } from './components/Observer/SuggestionsSidebar';
import { useObserverSuggestions, useObserverBriefing } from './hooks/useObserver';

/**
 * Inner shell — must live below `<QueryClientProvider>` so it can call
 * `useApiEventStream`, which needs the query client to invalidate caches
 * when the server pushes SSE events.
 */
function AppShell(): JSX.Element {
  // Subscribe to server-sent events once at app startup. The hook is a no-op
  // when SSE is unavailable, so this is safe in non-Electron contexts too.
  useApiEventStream();
  useQuickCaptureBridge();

  // Observer system
  const { suggestions, dismiss: dismissSuggestion, execute: executeSuggestion } = useObserverSuggestions();
  const { briefing, showBriefing, dismiss: dismissBriefing } = useObserverBriefing();

  return (
    <div className="flex h-full w-full">
      <div className="flex-1">
        <RouterProvider router={router} />
      </div>
      <SuggestionsSidebar
        onExecute={executeSuggestion}
        onDismiss={dismissSuggestion}
      />
      {suggestions.length > 0 && (
        <SuggestionToast
          suggestion={suggestions[0]}
          onDismiss={dismissSuggestion}
          onExecute={executeSuggestion}
        />
      )}
      {showBriefing && briefing && (
        <MorningBriefing
          briefing={briefing}
          onDismiss={dismissBriefing}
          onViewAll={() => {
            window.location.pathname = '/observer/suggestions';
          }}
        />
      )}
    </div>
  );
}

/**
 * Subscribe to "task captured via global hotkey" notices from the main
 * process and surface a toast + refresh the task list. Mount once at the
 * app root.
 */
function useQuickCaptureBridge(): void {
  const qc = useQueryClient();
  const { toast } = useToast();
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const bridge = (window as unknown as {
      taskpilot?: {
        onCaptureCreated?: (
          cb: (notice: { task_id: string; title: string }) => void,
        ) => () => void;
      };
    }).taskpilot;
    if (!bridge?.onCaptureCreated) return undefined;
    const off = bridge.onCaptureCreated((notice) => {
      toast({
        title: 'Captured',
        description: notice.title,
      });
      qc.invalidateQueries({ queryKey: queryKeys.tasks.all });
    });
    return off;
  }, [qc, toast]);
}

/**
 * Renders the global modals (command palette + shortcuts help) plus the
 * router shell. Lives inside `<KeyboardShortcutsProvider>` so it can read
 * the provider's open/close state.
 *
 * The new-task opener falls back to dispatching a DOM event when no view
 * has registered an explicit callback. Layout listens for that event and
 * shows its NewTaskDialog. This avoids forcing ownership of the dialog up
 * the tree just to satisfy the `n` shortcut.
 */
function AppWithShortcuts(): JSX.Element {
  const shortcuts = useKeyboardShortcuts();

  const openNewTaskDialog = (): void => {
    const opener = shortcuts.openNewTaskDialog;
    if (opener) {
      opener();
      return;
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(NEW_TASK_EVENT));
    }
  };

  return (
    <>
      <AppShell />
      <CommandPalette
        open={shortcuts.paletteOpen}
        onClose={shortcuts.closeCommandPalette}
        onOpenNewTaskDialog={openNewTaskDialog}
      />
      <ShortcutsHelp open={shortcuts.helpOpen} onClose={shortcuts.closeHelp} />
    </>
  );
}

/**
 * Top-level app shell. Wraps the router in QueryClientProvider so any view
 * can use react-query. Uses the singleton `queryClient` from `lib/query.ts`
 * so SSE invalidation hits the same cache as the hook layer.
 */
export default function App(): JSX.Element {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <KeyboardShortcutsProvider>
          <AppWithShortcuts />
          <Toaster />
        </KeyboardShortcutsProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
