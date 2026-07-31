/**
 * KeyboardShortcutsProvider
 *
 * Mounts the global hotkey bindings used by the entire shell. Provides a
 * React context so other components can:
 *   - Open the command palette / shortcuts help imperatively
 *   - Register their `openNewTaskDialog` callback (Layout owns the actual
 *     dialog state via a custom DOM event — see `Layout.tsx` — but the
 *     provider exposes the slot so consumers can wire alternative dialogs
 *     during testing).
 *
 * Architecture note: the `n` shortcut dispatches a `taskpilot:open-new-task`
 * DOM event rather than calling a callback directly. Layout listens for that
 * event and toggles its NewTaskDialog state. This avoids forcing every
 * dialog owner to subscribe to the provider, while still letting the
 * shortcut work from any focused view.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { register, setSuppressed } from '@/renderer/lib/hotkeys';

/** Public context shape exposed to consumers via `useKeyboardShortcuts()`. */
export interface KeyboardShortcutsContextValue {
  /** Open the global command palette. */
  openCommandPalette: () => void;
  /** Open the keyboard shortcuts help dialog. */
  openHelp: () => void;
  /**
   * Currently-registered new-task opener, or `null` if no view has set one.
   * Layout owns the canonical handler via DOM events, but tests / alternative
   * shells can override by setting this slot.
   */
  openNewTaskDialog: (() => void) | null;
  /** Replace the new-task opener (pass `null` on cleanup). */
  setOpenNewTaskDialog: (fn: (() => void) | null) => void;
  /** Whether the command palette is currently open. */
  paletteOpen: boolean;
  /** Whether the shortcuts help dialog is currently open. */
  helpOpen: boolean;
  /** Imperative palette close — used by the palette component itself. */
  closeCommandPalette: () => void;
  /** Imperative help close — used by the help dialog component itself. */
  closeHelp: () => void;
}

const KeyboardShortcutsContext =
  createContext<KeyboardShortcutsContextValue | null>(null);

/** Custom DOM events the provider dispatches to decouple from Layout state. */
export const NEW_TASK_EVENT = 'taskpilot:open-new-task';
export const OPEN_HELP_EVENT = 'taskpilot:open-shortcuts-help';

/**
 * Helper consumed by Sidebar's "Show shortcuts" footer link. Lives here so
 * the event name only exists in one place.
 */
export function dispatchOpenHelp(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(OPEN_HELP_EVENT));
}

interface ProviderProps {
  children: ReactNode;
}

/** Detect editable focus — duplicates hotkeys.ts logic for the `n` guard. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return (target as HTMLElement).isContentEditable;
}

/**
 * Hash-based navigation. The app uses `createHashRouter`, so writing the URL
 * hash directly triggers the same routing as `useNavigate` — and lets the
 * provider sit OUTSIDE `<RouterProvider>` cleanly, avoiding the chicken/egg
 * with the router context.
 */
function navigateHash(to: string): void {
  if (typeof window === 'undefined') return;
  const normalized = to.startsWith('/') ? to : `/${to}`;
  window.location.hash = `#${normalized}`;
}

export function KeyboardShortcutsProvider({
  children,
}: ProviderProps): JSX.Element {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  // Use a ref so a registered handler always sees the latest opener without
  // re-binding hotkeys whenever the slot is replaced.
  const newTaskDialogRef = useRef<(() => void) | null>(null);
  const [newTaskDialogVersion, setNewTaskDialogVersion] = useState(0);

  const setOpenNewTaskDialog = useCallback(
    (fn: (() => void) | null): void => {
      newTaskDialogRef.current = fn;
      // Bump a version counter so consumers re-render when the slot changes.
      setNewTaskDialogVersion((v) => v + 1);
    },
    [],
  );

  const openCommandPalette = useCallback((): void => {
    setHelpOpen(false);
    setPaletteOpen(true);
  }, []);

  const closeCommandPalette = useCallback((): void => {
    setPaletteOpen(false);
  }, []);

  const openHelp = useCallback((): void => {
    setPaletteOpen(false);
    setHelpOpen(true);
  }, []);

  const closeHelp = useCallback((): void => {
    setHelpOpen(false);
  }, []);

  // Suppress hotkeys while either modal is open so typing in their inputs
  // doesn't fire chord sequences.
  useEffect(() => {
    setSuppressed(paletteOpen || helpOpen);
    return () => {
      setSuppressed(false);
    };
  }, [paletteOpen, helpOpen]);

  // Subscribe to the OPEN_HELP event so the Sidebar footer link can ask us
  // to open the help dialog without a context dependency.
  useEffect(() => {
    const handler = (): void => openHelp();
    window.addEventListener(OPEN_HELP_EVENT, handler);
    return () => window.removeEventListener(OPEN_HELP_EVENT, handler);
  }, [openHelp]);

  // Bind all global hotkeys. Navigation uses hash assignment (see
  // `navigateHash`) so the provider can live outside the router context.
  useEffect(() => {
    const unsubs: Array<() => void> = [];

    // Command palette.
    unsubs.push(register('cmd+k', () => openCommandPalette()));

    // Shortcuts help.
    unsubs.push(register('?', () => openHelp()));

    // Navigation chords.
    const navChord = (combo: string, to: string): void => {
      unsubs.push(register(combo, () => navigateHash(to)));
    };
    navChord('g i', '/inbox');
    navChord('g y', '/');
    navChord('g b', '/board');
    navChord('g r', '/review');
    navChord('g c', '/calendar');
    navChord('g p', '/plan');
    navChord('g d', '/io');
    navChord('g s', '/settings');
    navChord('g t', '/templates');
    navChord('g a', '/archive');
    navChord('g j', '/projects');
    navChord('g w', '/cowork');
    navChord('g e', '/agents');
    navChord('g m', '/import');
    navChord('g x', '/reports');
    navChord('g o', '/about');
    navChord('g h', '/watch');
    navChord('g v', '/conversations');
    navChord('g u', '/businesses');
    navChord('g k', '/content');

    // New task — guard against editable focus and missing opener.
    unsubs.push(
      register('n', () => {
        if (isEditableTarget(document.activeElement)) return;
        const opener = newTaskDialogRef.current;
        if (opener) {
          opener();
          return;
        }
        // Fallback: dispatch the DOM event so Layout's listener fires even if
        // no consumer has registered an explicit opener yet.
        window.dispatchEvent(new CustomEvent(NEW_TASK_EVENT));
      }),
    );

    // Triage inbox — only from the inbox view (hash `#/`). Pressing `t`
    // elsewhere is a no-op so it doesn't hijack the key on other screens.
    unsubs.push(
      register('t', () => {
        if (isEditableTarget(document.activeElement)) return;
        const hash = window.location.hash.replace(/^#/, '');
        const onInbox = hash === '/inbox';
        if (!onInbox) return;
        navigateHash('/triage');
      }),
    );

    // Memory capture — global. Dispatches a CustomEvent that the Layout
    // shell listens for; opens the capture dialog overlaid on whichever
    // view is current. Defaults to text mode; the palette has a separate
    // entry for URL mode.
    unsubs.push(
      register('m', () => {
        if (isEditableTarget(document.activeElement)) return;
        window.dispatchEvent(
          new CustomEvent('taskpilot:open-memory-capture', {
            detail: { kind: 'text' },
          }),
        );
      }),
    );

    // Search focus — try to find a marked search input on the current view.
    unsubs.push(
      register('cmd+f', () => {
        const el = document.querySelector<HTMLElement>(
          '[data-shortcut-target="search"]',
        );
        if (el) {
          el.focus();
          if (el instanceof HTMLInputElement) el.select();
        }
      }),
    );

    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [openCommandPalette, openHelp]);

  // Memoize context value — re-render only when state we actually expose
  // changes. `newTaskDialogVersion` is included so consumers reading the
  // slot get the latest reference.
  const value = useMemo<KeyboardShortcutsContextValue>(
    () => ({
      openCommandPalette,
      openHelp,
      openNewTaskDialog: newTaskDialogRef.current,
      setOpenNewTaskDialog,
      paletteOpen,
      helpOpen,
      closeCommandPalette,
      closeHelp,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      openCommandPalette,
      openHelp,
      setOpenNewTaskDialog,
      paletteOpen,
      helpOpen,
      closeCommandPalette,
      closeHelp,
      newTaskDialogVersion,
    ],
  );

  return (
    <KeyboardShortcutsContext.Provider value={value}>
      {children}
    </KeyboardShortcutsContext.Provider>
  );
}

/** Consumer hook — throws if used outside the provider. */
export function useKeyboardShortcuts(): KeyboardShortcutsContextValue {
  const ctx = useContext(KeyboardShortcutsContext);
  if (!ctx) {
    throw new Error(
      'useKeyboardShortcuts must be used within a KeyboardShortcutsProvider',
    );
  }
  return ctx;
}
