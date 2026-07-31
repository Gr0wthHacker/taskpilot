/**
 * Public surface for the browser module — Chrome lifecycle + CDP-backed
 * page actions.
 */

export {
  CHROME_DEBUG_PORT,
  CHROME_PROFILE_DIR,
  ensureChrome,
  findChromeBinary,
  stopChrome,
  currentHandle,
} from './chrome';
export type { ChromeHandle, EnsureChromeOptions } from './chrome';

export {
  BrowserError,
  captureScreenshot,
  clickSelector,
  closeAllSessions,
  closeSession,
  evalExpression,
  getText,
  listSessions,
  openSession,
  typeIntoSelector,
} from './cdp';
export type { BrowserSession } from './cdp';
