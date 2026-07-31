/**
 * Minimal natural-language due-date parser.
 *
 * Lives in the renderer because it's used by the SmartDueInput component;
 * exported as a pure function with no external dependencies so it's trivial
 * to unit-test in node (`tests/parse-due.test.ts`).
 *
 * Supported patterns (case-insensitive, leading/trailing whitespace ignored):
 *
 *   - ""                          → null (empty)
 *   - "today"                     → today at 17:00 local
 *   - "tonight"                   → today at 20:00 local
 *   - "tomorrow"                  → tomorrow at 09:00 local
 *   - "tomorrow at 3pm"           → tomorrow at 15:00 local
 *   - "monday" / "tuesday" / ...  → next occurrence of that weekday at 09:00
 *                                   (if today is that weekday, advance one week)
 *   - "next monday"               → following week's monday at 09:00
 *   - "friday at 3pm"             → next friday at 15:00 local
 *   - "3pm friday"                → same as "friday at 3pm"
 *   - "in 3 days" / "in 2 weeks"  → today + N units, time preserved from
 *                                   current hour:minute (rounded to minute)
 *   - "12/25" / "12-25"           → current year (or next year if past) at 09:00
 *   - "dec 25"                    → as above
 *   - "2026-06-15"                → strict ISO date at 09:00 local
 *
 * The parser is intentionally narrow — it covers ~10 common phrasings, no
 * more. Anything outside the table returns `parsed: null` so the UI can fall
 * back to manual entry without surprising the user.
 *
 * `referenceNow` overrides "now" — keeps tests deterministic. Production
 * callers omit it.
 */

export interface ParseDueResult {
  /** The parsed Date, or null if input is empty / unparseable. */
  parsed: Date | null;
  /** Human-readable description of the rule that matched. Empty when null. */
  source: string;
  /** The raw input (trimmed) the user typed. */
  raw: string;
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

const MONTHS: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sep: 8,
  sept: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};

const DEFAULT_HOUR = 9;
const TODAY_DEFAULT_HOUR = 17;
const TONIGHT_HOUR = 20;

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function withTime(d: Date, hours: number, minutes: number): Date {
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    hours,
    minutes,
    0,
    0,
  );
}

/**
 * Parse "3pm", "3:30pm", "15:00", "9am", "9", returning {hours, minutes} or null.
 */
function parseTime(raw: string): { hours: number; minutes: number } | null {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return null;

  // 12h with optional minutes: 3pm, 3:15am, 12:00pm
  const twelve = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(trimmed);
  if (twelve) {
    let h = Number.parseInt(twelve[1]!, 10);
    const m = twelve[2] ? Number.parseInt(twelve[2], 10) : 0;
    const isPm = twelve[3]!.toLowerCase() === 'pm';
    if (h < 1 || h > 12 || m < 0 || m > 59) return null;
    if (h === 12) h = 0;
    if (isPm) h += 12;
    return { hours: h, minutes: m };
  }

  // 24h: 15:00, 09:30
  const twentyfour = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (twentyfour) {
    const h = Number.parseInt(twentyfour[1]!, 10);
    const m = Number.parseInt(twentyfour[2]!, 10);
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    return { hours: h, minutes: m };
  }

  return null;
}

/**
 * Return the next Date whose weekday matches `targetDow`, after `from`.
 *
 * - If `from` is the same weekday and `advanceIfSameDay`, jumps to the next
 *   occurrence (7 days out). Otherwise returns today.
 */
function nextWeekday(
  from: Date,
  targetDow: number,
  advanceIfSameDay: boolean,
): Date {
  const current = from.getDay();
  let diff = (targetDow - current + 7) % 7;
  if (diff === 0 && advanceIfSameDay) diff = 7;
  const next = startOfDay(from);
  next.setDate(next.getDate() + diff);
  return next;
}

/**
 * Strip a trailing "at TIME" clause from `raw`, returning the time match
 * (if any) and the cleaned-up base phrase.
 */
function extractAtTime(raw: string): {
  base: string;
  time: { hours: number; minutes: number } | null;
} {
  // " at 3pm", " @ 3pm", " 3pm", " at 15:00"
  const atRe = /\s+(?:at|@)\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?|[0-9]{1,2}:[0-9]{2})\s*$/i;
  const m = atRe.exec(raw);
  if (m) {
    const time = parseTime(m[1]!);
    if (time) {
      return { base: raw.slice(0, m.index).trim(), time };
    }
  }
  // Trailing bare time: "tomorrow 3pm"
  const trailingTime = /\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)|[0-9]{1,2}:[0-9]{2})\s*$/i.exec(
    raw,
  );
  if (trailingTime) {
    const time = parseTime(trailingTime[1]!);
    if (time) {
      return { base: raw.slice(0, trailingTime.index).trim(), time };
    }
  }
  // Leading time: "3pm friday"
  const leadingTime = /^([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)|[0-9]{1,2}:[0-9]{2})\s+/i.exec(
    raw,
  );
  if (leadingTime) {
    const time = parseTime(leadingTime[1]!);
    if (time) {
      return {
        base: raw.slice(leadingTime[0].length).trim(),
        time,
      };
    }
  }
  return { base: raw, time: null };
}

/**
 * Resolve `input` (a casual phrase the user typed) into a concrete Date.
 *
 * Returns `parsed: null` for empty / unrecognized input — callers should
 * preserve the raw text and let the user fix it.
 */
export function parseDue(
  input: string,
  referenceNow: Date = new Date(),
): ParseDueResult {
  const raw = input.trim();
  if (raw.length === 0) {
    return { parsed: null, source: '', raw: '' };
  }

  const lower = raw.toLowerCase();
  const { base, time } = extractAtTime(lower);
  const baseTrim = base.trim();

  // "today" / "tonight"
  if (baseTrim === 'today') {
    const t = time ?? { hours: TODAY_DEFAULT_HOUR, minutes: 0 };
    return {
      parsed: withTime(referenceNow, t.hours, t.minutes),
      source: time ? `today at ${formatTime(t)}` : `today at ${formatTime(t)}`,
      raw,
    };
  }
  if (baseTrim === 'tonight') {
    const t = time ?? { hours: TONIGHT_HOUR, minutes: 0 };
    return {
      parsed: withTime(referenceNow, t.hours, t.minutes),
      source: `tonight at ${formatTime(t)}`,
      raw,
    };
  }

  // "tomorrow"
  if (baseTrim === 'tomorrow') {
    const next = startOfDay(referenceNow);
    next.setDate(next.getDate() + 1);
    const t = time ?? { hours: DEFAULT_HOUR, minutes: 0 };
    return {
      parsed: withTime(next, t.hours, t.minutes),
      source: `tomorrow at ${formatTime(t)}`,
      raw,
    };
  }

  // "next monday", "next fri", etc.
  const nextDow = /^next\s+([a-z]+)$/i.exec(baseTrim);
  if (nextDow) {
    const dow = WEEKDAYS[nextDow[1]!];
    if (dow !== undefined) {
      // "next monday" → following week's monday, even if today is monday.
      const today = startOfDay(referenceNow);
      const target = nextWeekday(today, dow, true);
      const t = time ?? { hours: DEFAULT_HOUR, minutes: 0 };
      return {
        parsed: withTime(target, t.hours, t.minutes),
        source: `next ${weekdayName(dow)} at ${formatTime(t)}`,
        raw,
      };
    }
  }

  // Bare weekday: "friday"
  if (WEEKDAYS[baseTrim] !== undefined) {
    const dow = WEEKDAYS[baseTrim]!;
    const today = startOfDay(referenceNow);
    // Per spec: if today is the same weekday, jump to next week.
    const target = nextWeekday(today, dow, true);
    const t = time ?? { hours: DEFAULT_HOUR, minutes: 0 };
    return {
      parsed: withTime(target, t.hours, t.minutes),
      source: `${weekdayName(dow)} at ${formatTime(t)}`,
      raw,
    };
  }

  // "in 3 days", "in 2 weeks", "in 1 month"
  const inN = /^in\s+(\d+)\s+(day|days|week|weeks|month|months)$/i.exec(
    baseTrim,
  );
  if (inN) {
    const n = Number.parseInt(inN[1]!, 10);
    const unit = inN[2]!.toLowerCase();
    if (Number.isFinite(n) && n >= 0) {
      const target = new Date(referenceNow);
      if (unit.startsWith('day')) target.setDate(target.getDate() + n);
      else if (unit.startsWith('week')) target.setDate(target.getDate() + n * 7);
      else if (unit.startsWith('month'))
        target.setMonth(target.getMonth() + n);
      const t = time ?? {
        hours: target.getHours(),
        minutes: target.getMinutes(),
      };
      return {
        parsed: withTime(target, t.hours, t.minutes),
        source: `in ${n} ${unit}`,
        raw,
      };
    }
  }

  // Strict ISO date: YYYY-MM-DD
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(baseTrim);
  if (iso) {
    const y = Number.parseInt(iso[1]!, 10);
    const mo = Number.parseInt(iso[2]!, 10);
    const da = Number.parseInt(iso[3]!, 10);
    const candidate = new Date(y, mo - 1, da, 0, 0, 0, 0);
    if (
      candidate.getFullYear() === y &&
      candidate.getMonth() === mo - 1 &&
      candidate.getDate() === da
    ) {
      const t = time ?? { hours: DEFAULT_HOUR, minutes: 0 };
      return {
        parsed: withTime(candidate, t.hours, t.minutes),
        source: `${iso[1]}-${iso[2]}-${iso[3]} at ${formatTime(t)}`,
        raw,
      };
    }
  }

  // Numeric short date: 12/25, 12-25, 12/25/2026
  const numShort = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/.exec(baseTrim);
  if (numShort) {
    const mo = Number.parseInt(numShort[1]!, 10);
    const da = Number.parseInt(numShort[2]!, 10);
    const yRaw = numShort[3];
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
      let year: number;
      if (yRaw) {
        year = Number.parseInt(yRaw, 10);
        if (year < 100) year += 2000;
      } else {
        // Current year, or next year if the date is already past.
        const todayMidnight = startOfDay(referenceNow);
        const thisYearAttempt = new Date(
          referenceNow.getFullYear(),
          mo - 1,
          da,
          0,
          0,
          0,
          0,
        );
        year =
          thisYearAttempt.getTime() < todayMidnight.getTime()
            ? referenceNow.getFullYear() + 1
            : referenceNow.getFullYear();
      }
      const candidate = new Date(year, mo - 1, da, 0, 0, 0, 0);
      if (
        candidate.getFullYear() === year &&
        candidate.getMonth() === mo - 1 &&
        candidate.getDate() === da
      ) {
        const t = time ?? { hours: DEFAULT_HOUR, minutes: 0 };
        return {
          parsed: withTime(candidate, t.hours, t.minutes),
          source: `${monthShortName(mo - 1)} ${da}, ${year} at ${formatTime(t)}`,
          raw,
        };
      }
    }
  }

  // "dec 25", "december 25", "dec 25 2026"
  const monthDay = /^([a-z]+)\s+(\d{1,2})(?:[,]?\s+(\d{2,4}))?$/i.exec(
    baseTrim,
  );
  if (monthDay) {
    const monKey = monthDay[1]!.toLowerCase();
    const monIdx = MONTHS[monKey];
    if (monIdx !== undefined) {
      const da = Number.parseInt(monthDay[2]!, 10);
      const yRaw = monthDay[3];
      if (da >= 1 && da <= 31) {
        let year: number;
        if (yRaw) {
          year = Number.parseInt(yRaw, 10);
          if (year < 100) year += 2000;
        } else {
          const todayMidnight = startOfDay(referenceNow);
          const thisYearAttempt = new Date(
            referenceNow.getFullYear(),
            monIdx,
            da,
            0,
            0,
            0,
            0,
          );
          year =
            thisYearAttempt.getTime() < todayMidnight.getTime()
              ? referenceNow.getFullYear() + 1
              : referenceNow.getFullYear();
        }
        const candidate = new Date(year, monIdx, da, 0, 0, 0, 0);
        if (
          candidate.getFullYear() === year &&
          candidate.getMonth() === monIdx &&
          candidate.getDate() === da
        ) {
          const t = time ?? { hours: DEFAULT_HOUR, minutes: 0 };
          return {
            parsed: withTime(candidate, t.hours, t.minutes),
            source: `${monthShortName(monIdx)} ${da}, ${year} at ${formatTime(t)}`,
            raw,
          };
        }
      }
    }
  }

  return { parsed: null, source: '', raw };
}

function weekdayName(dow: number): string {
  const names = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ];
  return names[dow] ?? '';
}

function monthShortName(idx: number): string {
  const names = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return names[idx] ?? '';
}

function formatTime(t: { hours: number; minutes: number }): string {
  const h12 = t.hours % 12 === 0 ? 12 : t.hours % 12;
  const ampm = t.hours < 12 ? 'am' : 'pm';
  const mm = t.minutes.toString().padStart(2, '0');
  if (t.minutes === 0) return `${h12}${ampm}`;
  return `${h12}:${mm}${ampm}`;
}

/**
 * Render a human-readable preview like "Tomorrow, Dec 25 at 9:00am".
 *
 * The SmartDueInput uses this to confirm what we interpreted under the
 * input box. Lives next to the parser so both share the same vocabulary
 * for time/weekday formatting.
 */
export function formatDuePreview(d: Date): string {
  const weekday = weekdayName(d.getDay());
  const month = monthShortName(d.getMonth());
  const day = d.getDate();
  const t = { hours: d.getHours(), minutes: d.getMinutes() };
  return `${weekday}, ${month} ${day} at ${formatTime(t)}`;
}
