/**
 * Public surface for desktop input — screenshot + mouse + keyboard.
 *
 * All operations are gated behind the `desktop_input_enabled` setting
 * (default false). Calling any function without first enabling will throw
 * `DesktopInputDisabledError`.
 *
 * Windows-only in v1. macOS/Linux support requires a native input library.
 */

export {
  captureScreen,
  clickAt,
  ensureDesktopEnabled,
  getPrimaryScreenSize,
  escapeSendKeys,
  moveMouse,
  sendKeys,
  DesktopInputDisabledError,
  DesktopInputUnsupportedError,
} from './input';
export type { MouseButton, ScreenSize, ScreenshotResult } from './input';
