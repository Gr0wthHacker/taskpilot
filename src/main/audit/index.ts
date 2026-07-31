/**
 * Public surface of the ambient audit log module. Lives behind a barrel so
 * the rest of the codebase imports a stable name (`@/main/audit`) and the
 * internal split between log/reader/retention can evolve freely.
 */

export {
  __resetSafeStorageCacheForTests,
  __setSafeStorageForTests,
  appendAuditEvent,
  appendAuditEventSafe,
  auditFilePathFor,
  deserializeAuditLine,
  logPanicWipe,
  serializeAuditLine,
  type AppendAuditEventInput,
  type AuditEvent,
  type AuditEventKind,
} from './log';

export {
  countAuditFiles,
  readRecentAuditEvents,
  type ReadRecentAuditEventsOptions,
} from './reader';

export {
  computeCutoffDate,
  runAuditRetention,
  startAuditRetention,
  type AuditRetentionHandle,
  type AuditRetentionOptions,
  type RetentionSweepResult,
} from './retention';
