/**
 * Shared error types for the HTTP server.
 *
 * Route handlers `throw new ApiHttpError(404, 'not_found', 'task not found')`
 * and the global error middleware translates it into the canonical body shape:
 *   `{ error: { code, message } }`.
 */

export class ApiHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiHttpError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
