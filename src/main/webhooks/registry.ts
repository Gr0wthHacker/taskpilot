/**
 * Generic webhook config registry.
 *
 * Persists `WebhookConfig` records under a single `webhook_configs` setting
 * row. Storing the whole list in one JSON blob keeps schema changes cheap
 * (no migration needed) and the config volume is tiny — a typical install
 * has fewer than ten webhooks.
 *
 * Each config carries a slug-style `name` that becomes the URL segment:
 *
 *     POST /api/webhooks/incoming/<name>
 *
 * Wave 13 — Agent M.
 */

import { nanoid } from 'nanoid';

import { settingsRepository } from '@/main/db/repositories/settings';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A single mapping rule. The dispatcher walks the array in order and runs
 * any rule whose `match` succeeds (or which has no `match` at all). Each
 * rule's `template` is interpolated against the payload before the action
 * fires.
 *
 * Template strings use `{{path.to.field}}` substitution. Paths are dotted
 * (e.g. `issue.title`, `repository.full_name`) and resolved against the
 * decoded JSON body.
 */
export interface MappingRule {
  match?: {
    /** Dotted JSON path, e.g. `action` or `issue.state`. */
    path: string;
    /** Compared with strict equality after coercing both sides to string
     * for the common case where webhooks send `42` vs the config saying
     * `"42"`. */
    equals: unknown;
  };
  action: 'create_task' | 'update_task' | 'comment_task';
  template: {
    title?: string;
    description?: string;
    priority?: 'p0' | 'p1' | 'p2' | 'p3';
    tags?: string[];
    /** Required when action is `update_task` or `comment_task`. May be a
     * literal task id or a `{{...}}` template. */
    task_id?: string;
    /** Note body for `comment_task` (appended to `context.notes`). */
    note?: string;
    /** Optional override for `agent_method` when creating tasks. */
    agent_method?: 'cowork' | 'cli' | 'either' | 'human_only';
  };
}

/**
 * A registered webhook configuration. `secret` and `signature_*` are
 * optional — when omitted, the dispatcher accepts unsigned requests
 * (useful for trusted private networks; the registry warns the renderer
 * UI to surface a yellow badge).
 */
export interface WebhookConfig {
  id: string;
  /** URL-safe segment used as the path suffix. Lowercase, alphanumeric,
   *  dashes only — enforced by `sanitizeName()`. */
  name: string;
  secret?: string;
  /** HTTP header that carries the HMAC. Defaults to `X-Signature-256`. */
  signature_header?: string;
  signature_algorithm: 'sha256' | 'sha1' | 'none';
  /**
   * Required when `signature_algorithm: 'none'`. An explicit acknowledgement
   * that this config will accept unsigned POSTs and that the operator has
   * placed the endpoint behind a trust boundary (private network, Tailscale,
   * etc.). The registry refuses to create or update a `'none'` config without
   * this flag set to `true`.
   */
  trusted_network_only?: boolean;
  mapping_rules: MappingRule[];
  enabled: boolean;
  created_at: string;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

const SETTINGS_KEY = 'webhook_configs';

const NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Force a candidate name into the slug shape. Empty result after sanitizing
 * means the input is invalid; the caller should 400.
 */
export function sanitizeName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

export function isValidName(name: string): boolean {
  return NAME_REGEX.test(name);
}

function nowIso(): string {
  return new Date().toISOString();
}

/* -------------------------------------------------------------------------- */
/*  Storage shape                                                             */
/* -------------------------------------------------------------------------- */

interface StoredShape {
  version: 1;
  configs: WebhookConfig[];
}

function loadAll(): WebhookConfig[] {
  try {
    const raw = settingsRepository.get<StoredShape | WebhookConfig[]>(
      SETTINGS_KEY,
    );
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'object' && Array.isArray((raw as StoredShape).configs)) {
      return (raw as StoredShape).configs;
    }
    return [];
  } catch {
    return [];
  }
}

function saveAll(configs: WebhookConfig[]): void {
  const blob: StoredShape = { version: 1, configs };
  settingsRepository.set(SETTINGS_KEY, blob);
}

/* -------------------------------------------------------------------------- */
/*  Public CRUD                                                               */
/* -------------------------------------------------------------------------- */

export function listConfigs(): WebhookConfig[] {
  return loadAll();
}

export function getConfig(id: string): WebhookConfig | null {
  return loadAll().find((c) => c.id === id) ?? null;
}

export function getConfigByName(name: string): WebhookConfig | null {
  return loadAll().find((c) => c.name === name) ?? null;
}

export interface CreateWebhookInput {
  name: string;
  secret?: string;
  signature_header?: string;
  signature_algorithm?: 'sha256' | 'sha1' | 'none';
  trusted_network_only?: boolean;
  mapping_rules?: MappingRule[];
  enabled?: boolean;
}

/**
 * Guard: `signature_algorithm: 'none'` accepts unsigned POSTs. Refuse to
 * create or update such a config without an explicit `trusted_network_only`
 * acknowledgement so a misconfiguration can't silently expose an unsigned
 * endpoint to the open internet.
 */
function assertSafeAlgorithm(
  algorithm: 'sha256' | 'sha1' | 'none' | undefined,
  trusted: boolean | undefined,
): void {
  if (algorithm === 'none' && !trusted) {
    throw new Error(
      "signature_algorithm: 'none' is only allowed when trusted_network_only=true. " +
        'Set the flag explicitly if this endpoint is gated by a trust boundary ' +
        '(localhost, Tailscale, or a private VPC).',
    );
  }
}

export function createConfig(input: CreateWebhookInput): WebhookConfig {
  const name = sanitizeName(input.name);
  if (!isValidName(name)) {
    throw new Error(`Invalid webhook name: ${input.name}`);
  }
  assertSafeAlgorithm(input.signature_algorithm, input.trusted_network_only);
  const existing = loadAll();
  if (existing.some((c) => c.name === name)) {
    throw new Error(`Webhook with name "${name}" already exists`);
  }

  const config: WebhookConfig = {
    id: nanoid(12),
    name,
    secret: input.secret,
    signature_header: input.signature_header ?? 'X-Signature-256',
    signature_algorithm: input.signature_algorithm ?? 'sha256',
    ...(input.trusted_network_only
      ? { trusted_network_only: true }
      : {}),
    mapping_rules: input.mapping_rules ?? [],
    enabled: input.enabled ?? true,
    created_at: nowIso(),
  };

  saveAll([...existing, config]);
  return config;
}

export interface UpdateWebhookInput {
  name?: string;
  secret?: string | null;
  signature_header?: string;
  signature_algorithm?: 'sha256' | 'sha1' | 'none';
  trusted_network_only?: boolean;
  mapping_rules?: MappingRule[];
  enabled?: boolean;
}

export function updateConfig(
  id: string,
  patch: UpdateWebhookInput,
): WebhookConfig | null {
  const all = loadAll();
  const idx = all.findIndex((c) => c.id === id);
  if (idx === -1) return null;

  const current = all[idx];
  // Compute the post-patch algorithm + trust state to enforce the
  // 'none' + trusted_network_only invariant after every update.
  const nextAlgorithm = patch.signature_algorithm ?? current.signature_algorithm;
  const nextTrusted =
    patch.trusted_network_only ?? current.trusted_network_only;
  assertSafeAlgorithm(nextAlgorithm, nextTrusted);

  const next: WebhookConfig = { ...current };

  if (patch.name !== undefined) {
    const cleaned = sanitizeName(patch.name);
    if (!isValidName(cleaned)) {
      throw new Error(`Invalid webhook name: ${patch.name}`);
    }
    if (all.some((c) => c.name === cleaned && c.id !== id)) {
      throw new Error(`Webhook with name "${cleaned}" already exists`);
    }
    next.name = cleaned;
  }
  if (patch.secret !== undefined) {
    next.secret = patch.secret === null ? undefined : patch.secret;
  }
  if (patch.signature_header !== undefined) {
    next.signature_header = patch.signature_header;
  }
  if (patch.signature_algorithm !== undefined) {
    next.signature_algorithm = patch.signature_algorithm;
  }
  if (patch.trusted_network_only !== undefined) {
    if (patch.trusted_network_only) {
      next.trusted_network_only = true;
    } else {
      delete next.trusted_network_only;
    }
  }
  if (patch.mapping_rules !== undefined) {
    next.mapping_rules = patch.mapping_rules;
  }
  if (patch.enabled !== undefined) {
    next.enabled = patch.enabled;
  }

  all[idx] = next;
  saveAll(all);
  return next;
}

export function deleteConfig(id: string): boolean {
  const all = loadAll();
  const filtered = all.filter((c) => c.id !== id);
  if (filtered.length === all.length) return false;
  saveAll(filtered);
  return true;
}

/**
 * Strip the shared secret before returning a config to the renderer.
 * The full secret is needed only during HMAC verification; surfacing it
 * to the UI would risk it leaking via screenshots/devtools. The list
 * endpoint returns a `has_secret: true` flag instead.
 */
export function redact(
  config: WebhookConfig,
): Omit<WebhookConfig, 'secret'> & { has_secret: boolean } {
  const { secret, ...rest } = config;
  return { ...rest, has_secret: typeof secret === 'string' && secret.length > 0 };
}
