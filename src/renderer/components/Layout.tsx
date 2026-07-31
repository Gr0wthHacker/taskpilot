import { useEffect, useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';

import Sidebar from './Sidebar';
import { NewTaskDialog } from '@/renderer/components/shared/NewTaskDialog';
import { MemoryCaptureDialog } from '@/renderer/components/shared/MemoryCaptureDialog';
import {
  NEW_TASK_EVENT,
  useKeyboardShortcuts,
} from './KeyboardShortcutsProvider';

/**
 * Top-level Layout. Owns a shell-level NewTaskDialog so the `n` shortcut
 * and the command palette's "New task" command can open it from anywhere
 * without forcing every view to surface its own dialog.
 *
 * Inbox still ships its own NewTaskDialog for the in-view "+ New" button.
 * The two coexist — Inbox's flow stays self-contained, while the global
 * shortcut uses the Layout-level dialog. The wiring is event-driven:
 *
 *   - The `n` key (from KeyboardShortcutsProvider) dispatches a
 *     `taskpilot:open-new-task` CustomEvent.
 *   - The "New task" palette command does the same thing via the provider's
 *     `openNewTaskDialog` slot, which Layout fills in on mount.
 *
 * That pattern keeps ownership clean: Layout doesn't have to know about
 * Inbox's existing dialog, and Inbox doesn't have to know about the global
 * shortcut.
 */
export default function Layout(): JSX.Element {
  const navigate = useNavigate();
  const shortcuts = useKeyboardShortcuts();
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memoryInitial, setMemoryInitial] = useState<'text' | 'url'>('text');

  // Register Layout's opener with the provider so direct context consumers
  // (e.g. future toolbar buttons) can open the dialog without dispatching
  // a DOM event.
  useEffect(() => {
    shortcuts.setOpenNewTaskDialog(() => setNewTaskOpen(true));
    return () => {
      shortcuts.setOpenNewTaskDialog(null);
    };
    // We only care about Layout mount/unmount — `shortcuts` is a stable
    // ref-backed object so we don't depend on it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Also accept the DOM event so the `n` shortcut works even if the
  // provider slot is unset (e.g. mid-mount race).
  useEffect(() => {
    const handler = (): void => setNewTaskOpen(true);
    window.addEventListener(NEW_TASK_EVENT, handler);
    return () => window.removeEventListener(NEW_TASK_EVENT, handler);
  }, []);

  // Memory capture — palette + global hotkey both fire this CustomEvent.
  // `detail.kind` flips the dialog between text + URL modes; default text.
  useEffect(() => {
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent<{ kind?: 'text' | 'url' }>).detail;
      setMemoryInitial(detail?.kind === 'url' ? 'url' : 'text');
      setMemoryOpen(true);
    };
    window.addEventListener('taskpilot:open-memory-capture', handler);
    return () =>
      window.removeEventListener('taskpilot:open-memory-capture', handler);
  }, []);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <Sidebar />
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
      <NewTaskDialog
        open={newTaskOpen}
        onOpenChange={setNewTaskOpen}
        onCreated={(id) => {
          navigate(`/task/${id}`);
        }}
      />
      <MemoryCaptureDialog
        open={memoryOpen}
        onOpenChange={setMemoryOpen}
        initialKind={memoryInitial}
      />
    </div>
  );
}
