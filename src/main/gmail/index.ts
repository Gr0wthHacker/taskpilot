/**
 * Public entry point for the Gmail integration.
 *
 * The Gmail module shares the Google OAuth2 client with the calendar
 * module — the user grants both scopes (Calendar + Gmail) in a single
 * consent flow. Tokens persist in `~/.taskpilot/tokens.json` (same file
 * the calendar module uses).
 *
 * Capability surface:
 *  - Status / connect / disconnect — `auth.ts`
 *  - Listing, fetch, drafts, send, labels — `operations.ts`
 *  - Inbox capture loop — `capture.ts`
 *
 * Sending mail is double-gated: the OAuth scope `gmail.send` must be
 * granted AND the `gmail_send_enabled` user setting must be true. Both
 * checks live in `auth.isSendAllowed()`.
 */

export {
  GMAIL_BASE_SCOPES,
  GMAIL_SEND_SCOPE,
  GmailApiError,
  GmailAuthError,
  GmailNotConfiguredError,
  buildScopeSet,
  disconnect,
  getOauthClient,
  getStatus,
  isSendAllowed,
  isSendEnabledInSettings,
  setSendEnabledInSettings,
  startAuthFlow,
  takeGmailState,
} from './auth';

export type { GmailStatus } from './auth';

export {
  applyLabel,
  createDraft,
  getMessage,
  getOrCreateLabel,
  listLabels,
  listMessages,
  sendMessage,
  buildPermalink,
} from './operations';

export type {
  ApplyLabelOptions,
  DraftInput,
  DraftResult,
  FullMessage,
  ListMessagesOptions,
  MessageRef,
  SendInput,
  SendResult,
} from './operations';

export {
  captureOnce,
  startGmailCapture,
  stopGmailCapture,
} from './capture';

export type { CaptureResult } from './capture';
