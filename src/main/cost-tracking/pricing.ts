/**
 * LLM model pricing table + cost calculator.
 *
 * Hardcoded rates are denominated in USD **per 1M tokens**. We deliberately
 * keep the list short — only models we're confident about land here. If a
 * task comes back with a model name we don't recognize, {@link computeCost}
 * returns 0 rather than guessing. The user can plug missing rates in via
 * the `model_pricing_override` setting (a JSON object keyed by model name).
 *
 * Sources (rounded to the nearest USD): Anthropic + OpenAI public pricing
 * pages as of May 2026. Cache-read tokens follow Anthropic's "10% of input
 * price" guidance; cache-creation is "1.25× input" (write-time fee).
 */

import { settingsRepository } from '@/main/db/repositories/settings';
import type { CostTokens } from '@/shared/types';

/* -------------------------------------------------------------------------- */
/*  Shape                                                                     */
/* -------------------------------------------------------------------------- */

export interface ModelPricing {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M cache-read tokens. Defaults to 10% of `input` when absent. */
  cache_read?: number;
  /** USD per 1M cache-creation tokens. Defaults to 125% of `input` when absent. */
  cache_creation?: number;
}

/* -------------------------------------------------------------------------- */
/*  Hardcoded rates                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Lowercase keys. {@link normalizeModel} maps incoming names (which may
 * carry suffixes like `[1m]`, version numbers, or vendor prefixes) to the
 * closest matching key.
 */
export const HARDCODED_PRICING: Readonly<Record<string, ModelPricing>> = {
  /* Claude (Anthropic) ------------------------------------------------ */
  'claude-opus-4-7': { input: 15, output: 75, cache_read: 1.5, cache_creation: 18.75 },
  'claude-opus-4-6': { input: 15, output: 75, cache_read: 1.5, cache_creation: 18.75 },
  'claude-opus-4': { input: 15, output: 75, cache_read: 1.5, cache_creation: 18.75 },
  'claude-sonnet-4-6': { input: 3, output: 15, cache_read: 0.3, cache_creation: 3.75 },
  'claude-sonnet-4-5': { input: 3, output: 15, cache_read: 0.3, cache_creation: 3.75 },
  'claude-sonnet-4': { input: 3, output: 15, cache_read: 0.3, cache_creation: 3.75 },
  'claude-haiku-4': { input: 0.8, output: 4, cache_read: 0.08, cache_creation: 1 },
  'claude-haiku-3-5': { input: 0.8, output: 4, cache_read: 0.08, cache_creation: 1 },

  /* OpenAI ------------------------------------------------------------ */
  // Conservative — only the models with stable public pricing. Anyone
  // running a fine-tune or preview model should plug rates in via the
  // override setting.
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10, output: 30 },
  'gpt-4': { input: 30, output: 60 },
  'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
};

/* -------------------------------------------------------------------------- */
/*  Normalization                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Reduce a model identifier to a lookup key:
 *   - Strip any bracketed suffix `[1m]`, `(beta)`, etc.
 *   - Lowercase.
 *   - Drop leading vendor prefixes (`anthropic/`, `openai/`).
 *   - Drop the API date suffix Anthropic appends (`-20250101`).
 */
export function normalizeModel(raw: string): string {
  let v = raw.trim().toLowerCase();
  v = v.replace(/\[.*?\]|\(.*?\)/g, '').trim();
  v = v.replace(/^(anthropic|openai)\//, '');
  v = v.replace(/-(\d{4}-?\d{2}-?\d{2})$/, '');
  v = v.replace(/-(\d{8})$/, '');
  // Collapse repeated dashes from removed suffixes.
  v = v.replace(/-+/g, '-').replace(/-$/, '');
  return v;
}

/**
 * Pull a pricing row by name. The lookup order is:
 *   1. settings `model_pricing_override` keyed by raw + normalized name
 *   2. hardcoded table by normalized name
 *   3. hardcoded table by progressive prefix shortening (so
 *      `claude-opus-4-7-20251010` matches `claude-opus-4-7` etc.)
 *
 * Returns `null` when nothing matched.
 */
export function lookupPricing(rawName: string): ModelPricing | null {
  if (!rawName) return null;
  const override = readPricingOverride();

  const candidates: string[] = [];
  candidates.push(rawName);
  const normalized = normalizeModel(rawName);
  candidates.push(normalized);
  // Progressive prefix shortening: claude-opus-4-7 → claude-opus-4 → claude-opus
  const parts = normalized.split('-');
  while (parts.length > 1) {
    parts.pop();
    candidates.push(parts.join('-'));
  }

  for (const key of candidates) {
    if (override && key in override) {
      const row = override[key];
      if (row) return row;
    }
    if (key in HARDCODED_PRICING) {
      const row = HARDCODED_PRICING[key];
      if (row) return row;
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Cost calculation                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Compute USD for a single token-usage report. Returns 0 when the model is
 * unknown or no tokens were supplied. The result is rounded to 6 decimal
 * places so successive sums don't accumulate float noise.
 */
export function computeCost(tokens: CostTokens | undefined): number {
  if (!tokens) return 0;
  const model = tokens.model;
  if (!model) return 0;
  const pricing = lookupPricing(model);
  if (!pricing) return 0;

  const inputUsd = ((tokens.input ?? 0) * pricing.input) / 1_000_000;
  const outputUsd = ((tokens.output ?? 0) * pricing.output) / 1_000_000;
  const cacheReadRate = pricing.cache_read ?? pricing.input * 0.1;
  const cacheCreateRate = pricing.cache_creation ?? pricing.input * 1.25;
  const cacheReadUsd =
    ((tokens.cache_read ?? 0) * cacheReadRate) / 1_000_000;
  const cacheCreateUsd =
    ((tokens.cache_creation ?? 0) * cacheCreateRate) / 1_000_000;

  const total = inputUsd + outputUsd + cacheReadUsd + cacheCreateUsd;
  return Math.round(total * 1_000_000) / 1_000_000;
}

/* -------------------------------------------------------------------------- */
/*  Override settings                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Read the user-supplied pricing override. Stored as a JSON object under the
 * setting key `model_pricing_override`. Bogus entries are dropped silently —
 * we never want a broken override to crash a cost calculation.
 */
function readPricingOverride(): Record<string, ModelPricing> | null {
  try {
    const raw = settingsRepository.get<unknown>('model_pricing_override');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out: Record<string, ModelPricing> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        typeof (value as ModelPricing).input === 'number' &&
        typeof (value as ModelPricing).output === 'number'
      ) {
        out[normalizeModel(key)] = value as ModelPricing;
      }
    }
    return out;
  } catch {
    return null;
  }
}
