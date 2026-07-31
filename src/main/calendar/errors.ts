/**
 * Calendar-specific error classes.
 *
 * The HTTP layer (Wave 2E) inspects `error.code` to map these to HTTP status
 * codes:
 *   - `CALENDAR_NOT_CONFIGURED` -> 503 (Service Unavailable)
 *   - `CALENDAR_AUTH`           -> 401 (Unauthorized)
 *   - `CALENDAR_API`            -> 502 (Bad Gateway) or pass-through Google status
 */

export class CalendarNotConfiguredError extends Error {
  public readonly code = 'CALENDAR_NOT_CONFIGURED' as const;

  constructor(message = 'Google Calendar is not configured. Place credentials.json in ~/.taskpilot/ and complete the OAuth flow.') {
    super(message);
    this.name = 'CalendarNotConfiguredError';
  }
}

export class CalendarAuthError extends Error {
  public readonly code = 'CALENDAR_AUTH' as const;

  constructor(message: string) {
    super(message);
    this.name = 'CalendarAuthError';
  }
}

export class CalendarApiError extends Error {
  public readonly code = 'CALENDAR_API' as const;
  public readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'CalendarApiError';
    this.status = status;
  }
}
