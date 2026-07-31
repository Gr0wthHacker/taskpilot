/**
 * Public API for the calendar module.
 *
 * This is what Wave 1C's context-refresh dynamic-imports (looking for
 * `listEvents`) and what Wave 2E's HTTP layer will dynamic-import for the
 * `/api/calendar/*` endpoints. Keep the surface area tight — anything not
 * re-exported here is internal to the module.
 */

export {
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  getEvent,
  freeBusy,
  TASK_ID_PROP,
} from './google';

export type {
  CalendarEvent,
  CreateEventInput,
  UpdateEventPatch,
} from './google';

export { getAvailability } from './availability';
export { getAvailability as findAvailability } from './availability';
export type { AvailabilitySlot } from './availability';

export {
  startCalendarSync,
  stopCalendarSync,
  fullSync,
  taskUpdated,
  taskDeleted,
} from './sync';
export { fullSync as syncCalendar } from './sync';
export type { SyncResult, SyncError } from './sync';

export {
  getOauthClient,
  isAuthenticated,
  startAuthFlow,
  completeAuthFlow,
  signOut,
  SCOPES,
  TOKENS_PATH,
} from './oauth';

export { proposeSchedule } from './smart-schedule';
export type { ScheduleProposal, ProposeScheduleOptions } from './smart-schedule';

export { scheduleTask } from './schedule-task';
export type { ScheduleTaskOptions, ScheduleTaskResult } from './schedule-task';

export {
  CalendarNotConfiguredError,
  CalendarAuthError,
  CalendarApiError,
} from './errors';
