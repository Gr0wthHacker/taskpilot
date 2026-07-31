/**
 * Small date utilities shared across views. Previously each calendar/plan
 * surface kept its own identical `safeParse` copy.
 */

import { parseISO } from 'date-fns';

/**
 * Parse an ISO 8601 string into a Date, returning null for empty/invalid
 * input instead of an `Invalid Date`. Safe to call on untrusted strings.
 */
export function safeParseISO(iso: string): Date | null {
  try {
    const d = parseISO(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d;
  } catch {
    return null;
  }
}
