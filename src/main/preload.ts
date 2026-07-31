import { contextBridge, ipcRenderer } from 'electron';

// IPC channels — must match src/main/ipc.ts.
const CHANNEL_CONFIG = 'tp:config';
const CHANNEL_IO_EVENT = 'tp:io:event';
const CHANNEL_INGEST = 'tp:ingest';
const CHANNEL_OPEN_IO = 'tp:open-io-folder';
const CHANNEL_OPEN_EXTERNAL = 'tp:open-external';
const CHANNEL_TRAY_COMMAND = 'tp:tray:command';
const CHANNEL_API_TOKEN = 'tp:auth:token';
// Wave 11 / quick-capture window. Shared preload across windows; the
// capture window only ever invokes the capture-specific channels, the
// main window only listens for `captureCreated`. Keeping a single bridge
// avoids a separate preload bundle.
const CHANNEL_CAPTURE_SUBMIT = 'tp:capture:submit';
const CHANNEL_CAPTURE_DISMISS = 'tp:capture:dismiss';
const CHANNEL_CAPTURE_CREATED = 'tp:capture:created';
const CHANNEL_CAPTURE_FOCUS = 'tp:capture:focus';

export interface TaskpilotConfig {
  version: string;
  paths: Record<string, string>;
  api_port: number;
}

export interface IoEvent {
  kind: 'derived' | 'result' | 'inbox' | 'invalid' | 'unknown';
  task_id?: string;
  path: string;
  at: string; // ISO
}

/**
 * Commands fired by the system tray menu. Mirrors `TrayCommand` in
 * `src/main/ipc.ts` — kept duplicated here because preload.ts is bundled
 * separately and can't import from the main bundle at runtime.
 */
export type TrayCommand =
  | { kind: 'quick-add' }
  | { kind: 'navigate'; path: string };

/**
 * Toast payload pushed when the quick-capture window creates a task. The
 * main window subscribes via `onCaptureCreated` so the inbox view can show
 * a confirmation.
 */
export interface CapturedTaskNotice {
  task_id: string;
  title: string;
}

export interface TaskpilotBridge {
  getConfig: () => Promise<TaskpilotConfig>;
  /**
   * Read the per-install API bearer token from `~/.taskpilot/api-token`.
   * Used by the renderer's HTTP wrapper to authenticate every call. The
   * token is generated at first boot of the desktop app; if it's somehow
   * missing the main process regenerates it before returning.
   *
   * Returns the raw token string, or a structured error envelope if the
   * token file is unreadable (extremely rare — implies a corrupt
   * `~/.taskpilot/` install).
   */
  getApiToken: () => Promise<string | { error: { code: string; message: string } }>;
  onIOEvent: (cb: (event: IoEvent) => void) => () => void;
  /**
   * Subscribe to tray-menu commands forwarded from the main process.
   * Returns an unsubscribe function. The renderer's Layout component owns
   * the single live subscription and routes each command (quick-add,
   * navigate, etc.) to the appropriate handler.
   */
  onTrayCommand: (cb: (command: TrayCommand) => void) => () => void;
  triggerIngest: () => Promise<{ ok: boolean; message?: string }>;
  openIoFolder: () => Promise<{ ok: boolean; message?: string }>;
  /**
   * Open an arbitrary URL in the user's default external browser via
   * Electron's `shell.openExternal`. The main-process handler validates the
   * scheme (`http:` / `https:` / `mailto:`) before delegating, so the
   * renderer cannot be tricked into invoking arbitrary protocols.
   */
  openExternal: (url: string) => Promise<{ ok: boolean; message?: string }>;

  /* ----- Quick-capture window plumbing ------------------------------- */

  /**
   * Submit a task from the capture window. Main process forwards to
   * `POST /api/tasks` with `agent_method: 'either'` so auto-derive fires.
   * Returns `{ ok: true, task_id, title }` on success.
   */
  captureSubmit: (input: {
    title: string;
    description?: string | null;
  }) => Promise<
    | { ok: true; task_id: string; title: string }
    | { ok: false; message: string }
  >;
  /** Ask the main process to hide the capture window (Escape key handler). */
  captureDismiss: () => Promise<{ ok: boolean; message?: string }>;
  /** Subscribe to `tp:capture:focus` so the capture renderer can re-focus the input. */
  onCaptureFocus: (cb: () => void) => () => void;
  /** Subscribe to capture-created notices on the main window for toasts. */
  onCaptureCreated: (cb: (notice: CapturedTaskNotice) => void) => () => void;
}

const bridge: TaskpilotBridge = {
  getConfig: () => ipcRenderer.invoke(CHANNEL_CONFIG) as Promise<TaskpilotConfig>,
  getApiToken: () =>
    ipcRenderer.invoke(CHANNEL_API_TOKEN) as Promise<
      string | { error: { code: string; message: string } }
    >,
  onIOEvent: (cb) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: IoEvent): void => cb(payload);
    ipcRenderer.on(CHANNEL_IO_EVENT, handler);
    return () => ipcRenderer.removeListener(CHANNEL_IO_EVENT, handler);
  },
  onTrayCommand: (cb) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: TrayCommand,
    ): void => cb(payload);
    ipcRenderer.on(CHANNEL_TRAY_COMMAND, handler);
    return () => ipcRenderer.removeListener(CHANNEL_TRAY_COMMAND, handler);
  },
  triggerIngest: () =>
    ipcRenderer.invoke(CHANNEL_INGEST) as Promise<{ ok: boolean; message?: string }>,
  openIoFolder: () =>
    ipcRenderer.invoke(CHANNEL_OPEN_IO) as Promise<{ ok: boolean; message?: string }>,
  openExternal: (url) =>
    ipcRenderer.invoke(CHANNEL_OPEN_EXTERNAL, url) as Promise<{
      ok: boolean;
      message?: string;
    }>,
  captureSubmit: (input) =>
    ipcRenderer.invoke(CHANNEL_CAPTURE_SUBMIT, input) as Promise<
      | { ok: true; task_id: string; title: string }
      | { ok: false; message: string }
    >,
  captureDismiss: () =>
    ipcRenderer.invoke(CHANNEL_CAPTURE_DISMISS) as Promise<{
      ok: boolean;
      message?: string;
    }>,
  onCaptureFocus: (cb) => {
    const handler = (): void => cb();
    ipcRenderer.on(CHANNEL_CAPTURE_FOCUS, handler);
    return () => ipcRenderer.removeListener(CHANNEL_CAPTURE_FOCUS, handler);
  },
  onCaptureCreated: (cb) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: CapturedTaskNotice,
    ): void => cb(payload);
    ipcRenderer.on(CHANNEL_CAPTURE_CREATED, handler);
    return () => ipcRenderer.removeListener(CHANNEL_CAPTURE_CREATED, handler);
  },
};

contextBridge.exposeInMainWorld('taskpilot', bridge);

// Re-export the bridge type so the renderer can extend the Window interface.
declare global {
  interface Window {
    taskpilot: TaskpilotBridge;
  }
}
