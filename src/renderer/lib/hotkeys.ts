/**
 * Tiny hotkey engine.
 *
 * Listens once at the document level and dispatches to registered handlers.
 * Supports two flavors of binding:
 *
 *  - Single keys with optional modifiers, e.g. `"cmd+k"`, `"ctrl+enter"`,
 *    `"?"`, `"n"`. `cmd` matches `metaKey` on mac and `ctrlKey` elsewhere.
 *    `ctrl` always matches `ctrlKey`.
 *  - Chord sequences, e.g. `"g i"` — press `g` then `i` within 1 second.
 *    Sequences are space-separated. Modifiers inside a chord step are
 *    accepted but uncommon in practice.
 *
 * Safety rules:
 *  - Handlers never fire while focus is inside a form element
 *    (`<input>`, `<textarea>`, `[contenteditable]`, `<select>`) UNLESS the
 *    binding requires a modifier key (so `cmd+k` still works in the search
 *    box, but `n` does not).
 *  - The engine can be globally suppressed via `setSuppressed(true)` —
 *    used by the command palette / shortcuts help so a chord doesn't run
 *    while the palette itself is open.
 *
 * `register()` returns an unsubscribe function. The first call lazily
 * attaches the document listener; the last unsubscribe detaches it.
 */

/** Internal: one parsed binding step. */
interface ParsedStep {
  key: string; // lowercased KeyboardEvent.key
  cmd: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  requiresModifier: boolean;
}

interface ParsedBinding {
  steps: ParsedStep[];
  raw: string;
}

interface Registration {
  binding: ParsedBinding;
  handler: () => void;
}

const IS_MAC =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/i.test(navigator.platform);

const CHORD_TIMEOUT_MS = 1_000;

const registrations = new Set<Registration>();
let attached = false;
let suppressed = false;
let chordBuffer: ParsedStep[] = [];
let chordTimer: ReturnType<typeof setTimeout> | null = null;

/* -------------------------------------------------------------------------- */
/*  Parsing                                                                    */
/* -------------------------------------------------------------------------- */

/** Normalize a single key token to KeyboardEvent.key semantics. */
function normalizeKeyToken(token: string): string {
  const t = token.toLowerCase();
  switch (t) {
    case 'esc':
      return 'escape';
    case 'return':
      return 'enter';
    case 'space':
    case 'spacebar':
      return ' ';
    case 'plus':
      return '+';
    case 'slash':
      return '/';
    default:
      return t;
  }
}

function parseStep(stepStr: string): ParsedStep {
  // Split on `+`, but treat a trailing `+` as the `+` key itself (e.g. `cmd++`).
  const parts = stepStr.split('+').map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw new Error(`hotkeys: empty step in "${stepStr}"`);
  }
  let cmd = false;
  let ctrl = false;
  let alt = false;
  let shift = false;
  let key: string | null = null;
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'cmd' || lower === 'meta' || lower === 'mod') {
      cmd = true;
    } else if (lower === 'ctrl' || lower === 'control') {
      ctrl = true;
    } else if (lower === 'alt' || lower === 'option' || lower === 'opt') {
      alt = true;
    } else if (lower === 'shift') {
      shift = true;
    } else {
      key = normalizeKeyToken(part);
    }
  }
  if (key === null) {
    throw new Error(`hotkeys: no key in step "${stepStr}"`);
  }
  return {
    key,
    cmd,
    ctrl,
    alt,
    shift,
    requiresModifier: cmd || ctrl || alt,
  };
}

function parseBinding(binding: string): ParsedBinding {
  const stepStrs = binding
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (stepStrs.length === 0) {
    throw new Error(`hotkeys: empty binding`);
  }
  return {
    steps: stepStrs.map(parseStep),
    raw: binding,
  };
}

/* -------------------------------------------------------------------------- */
/*  Matching                                                                   */
/* -------------------------------------------------------------------------- */

function eventCmdActive(event: KeyboardEvent): boolean {
  // On mac, "cmd" = metaKey. Elsewhere, "cmd" matches ctrlKey (mod-key).
  return IS_MAC ? event.metaKey : event.ctrlKey;
}

function eventToStep(event: KeyboardEvent): ParsedStep {
  const cmd = eventCmdActive(event);
  const ctrl = !IS_MAC ? false : event.ctrlKey;
  return {
    key: event.key.toLowerCase(),
    cmd,
    ctrl,
    alt: event.altKey,
    shift: event.shiftKey,
    requiresModifier: cmd || event.ctrlKey || event.altKey,
  };
}

function stepsMatch(a: ParsedStep, b: ParsedStep): boolean {
  if (a.key !== b.key) return false;
  if (a.cmd !== b.cmd) return false;
  if (a.ctrl !== b.ctrl) return false;
  if (a.alt !== b.alt) return false;
  // shift is only enforced when the binding explicitly asks for it — many
  // keys (?, /, !) naturally require shift. If the binding doesn't request
  // shift we don't care whether the event had shift held.
  if (a.shift && !b.shift) return false;
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Focus / suppression                                                        */
/* -------------------------------------------------------------------------- */

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  const el = target as HTMLElement;
  if (el.isContentEditable) return true;
  return false;
}

/* -------------------------------------------------------------------------- */
/*  Event handling                                                             */
/* -------------------------------------------------------------------------- */

function resetChord(): void {
  chordBuffer = [];
  if (chordTimer) {
    clearTimeout(chordTimer);
    chordTimer = null;
  }
}

function scheduleChordReset(): void {
  if (chordTimer) clearTimeout(chordTimer);
  chordTimer = setTimeout(() => {
    chordBuffer = [];
    chordTimer = null;
  }, CHORD_TIMEOUT_MS);
}

function handleKeyDown(event: KeyboardEvent): void {
  if (suppressed) return;

  // Ignore pure modifier presses — they never form a binding step on their own.
  const k = event.key.toLowerCase();
  if (k === 'meta' || k === 'control' || k === 'alt' || k === 'shift') {
    return;
  }

  const observed = eventToStep(event);
  const editable = isEditableTarget(event.target);

  // Try single-step bindings first (most common). Only match a single-step
  // binding when no chord is in progress, so `g` doesn't trigger a hypothetical
  // bare-`g` binding mid-sequence.
  if (chordBuffer.length === 0) {
    for (const reg of registrations) {
      if (reg.binding.steps.length !== 1) continue;
      const [step] = reg.binding.steps;
      if (!step) continue;
      if (!stepsMatch(step, observed)) continue;
      // Block plain-key bindings when focus is in an editable element.
      if (editable && !step.requiresModifier) continue;
      event.preventDefault();
      resetChord();
      try {
        reg.handler();
      } catch (cause) {
        // eslint-disable-next-line no-console
        console.error('hotkeys handler threw', cause);
      }
      return;
    }
  }

  // Multi-step (chord) bindings. Block entirely while focus is editable —
  // chords are unmodified by definition and would conflict with typing.
  if (editable) {
    resetChord();
    return;
  }

  // Append the observed step to the chord buffer. If any registered binding
  // could still match this prefix, keep waiting; otherwise reset.
  const candidate = [...chordBuffer, observed];
  let exactMatch: Registration | null = null;
  let hasPrefix = false;
  for (const reg of registrations) {
    if (reg.binding.steps.length <= 1) continue;
    const steps = reg.binding.steps;
    if (candidate.length > steps.length) continue;
    let matches = true;
    for (let i = 0; i < candidate.length; i += 1) {
      const candStep = candidate[i];
      const targetStep = steps[i];
      if (!candStep || !targetStep || !stepsMatch(targetStep, candStep)) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    if (candidate.length === steps.length) {
      exactMatch = reg;
    } else {
      hasPrefix = true;
    }
  }

  if (exactMatch) {
    event.preventDefault();
    resetChord();
    try {
      exactMatch.handler();
    } catch (cause) {
      // eslint-disable-next-line no-console
      console.error('hotkeys handler threw', cause);
    }
    return;
  }

  if (hasPrefix) {
    chordBuffer = candidate;
    scheduleChordReset();
    return;
  }

  // No match and no live prefix — discard the buffer.
  resetChord();
}

function attachIfNeeded(): void {
  if (attached) return;
  if (typeof document === 'undefined') return;
  document.addEventListener('keydown', handleKeyDown);
  attached = true;
}

function detachIfEmpty(): void {
  if (!attached) return;
  if (registrations.size > 0) return;
  if (typeof document === 'undefined') return;
  document.removeEventListener('keydown', handleKeyDown);
  attached = false;
  resetChord();
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Register a hotkey. Returns an unsubscribe function.
 *
 * `binding` examples:
 *  - `"cmd+k"`  — Cmd on mac, Ctrl elsewhere
 *  - `"ctrl+f"` — always Ctrl
 *  - `"?"`      — bare question mark (no modifier required)
 *  - `"g i"`    — press G then I within 1 second
 */
export function register(binding: string, handler: () => void): () => void {
  const parsed = parseBinding(binding);
  const reg: Registration = { binding: parsed, handler };
  registrations.add(reg);
  attachIfNeeded();
  return () => {
    registrations.delete(reg);
    detachIfEmpty();
  };
}

/**
 * Globally suppress all hotkey dispatches. Used by the command palette /
 * shortcuts help so the user can type freely without triggering chords.
 */
export function setSuppressed(next: boolean): void {
  suppressed = next;
  if (next) resetChord();
}

/** Return `true` when the user is on a Mac (renderer-only). */
export function isMac(): boolean {
  return IS_MAC;
}

/** Format a key combo for display. `cmd+k` → `⌘K` on mac, `Ctrl+K` else. */
export function formatBinding(binding: string): string {
  return binding
    .split(/\s+/)
    .map((step) =>
      step
        .split('+')
        .map((part) => {
          const p = part.toLowerCase();
          if (p === 'cmd' || p === 'mod' || p === 'meta') {
            return IS_MAC ? '⌘' : 'Ctrl';
          }
          if (p === 'ctrl' || p === 'control') return 'Ctrl';
          if (p === 'alt' || p === 'option' || p === 'opt') {
            return IS_MAC ? '⌥' : 'Alt';
          }
          if (p === 'shift') return IS_MAC ? '⇧' : 'Shift';
          if (p === 'enter' || p === 'return') return '↵';
          if (p === 'escape' || p === 'esc') return 'Esc';
          if (p === ' ' || p === 'space') return 'Space';
          if (p.length === 1) return p.toUpperCase();
          return part[0]?.toUpperCase() + part.slice(1);
        })
        .join(IS_MAC ? '' : '+'),
    )
    .join(' then ');
}

/** Reset internal state — exposed for tests only. */
export function __resetHotkeys(): void {
  registrations.clear();
  resetChord();
  suppressed = false;
  if (attached && typeof document !== 'undefined') {
    document.removeEventListener('keydown', handleKeyDown);
    attached = false;
  }
}
