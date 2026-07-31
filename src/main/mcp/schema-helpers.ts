/**
 * Minimal Zod -> JSON Schema converter for the patterns used by TaskPilot's
 * MCP tools.
 *
 * The MCP protocol requires every tool to declare a JSON Schema describing
 * its input shape (the `inputSchema` field on the Tool object). We use Zod
 * for the actual runtime validation inside handlers, but Claude — the MCP
 * client — only sees the JSON Schema. This module bridges the two without
 * pulling in `zod-to-json-schema` (not on our approved dep list).
 *
 * Coverage is intentionally narrow:
 *   - `z.object({...})` (record of named props)
 *   - `z.string()` / `.min()` / `.email()` (treated as plain string)
 *   - `z.number()` / `z.int()`
 *   - `z.boolean()`
 *   - `z.array(<inner>)`
 *   - `z.enum([...])`
 *   - `z.literal('x')` (only string literals)
 *   - `z.record(z.string(), <inner>)` -> `{ type: 'object', additionalProperties: <inner> }`
 *   - `.optional()` / `.nullable()` / `.nullish()` (unwrapped recursively)
 *
 * Anything not handled falls through to `{}` (an empty schema), which still
 * passes MCP's required-shape check but won't give Claude useful hints.
 */

import { z } from 'zod';

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: readonly (string | number | boolean)[];
  description?: string;
  additionalProperties?: boolean | JsonSchema;
  const?: string | number | boolean;
  format?: string;
  minimum?: number;
  maximum?: number;
}

/**
 * Convert a Zod schema (root-level `z.object` strongly preferred) into a JSON
 * Schema fragment that MCP clients can consume as `inputSchema`.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  return convert(schema);
}

function convert(schema: z.ZodTypeAny): JsonSchema {
  const def = (schema as { _def?: { typeName?: string } })._def;
  const typeName = def?.typeName;

  // Unwrap optional / nullable / default / effects so callers don't need to
  // care which order modifiers were applied in.
  if (typeName === 'ZodOptional' || typeName === 'ZodNullable') {
    const inner = (schema as unknown as { _def: { innerType: z.ZodTypeAny } })._def
      .innerType;
    const result = convert(inner);
    if (typeName === 'ZodNullable') {
      return widenForNull(result);
    }
    return result;
  }

  if (typeName === 'ZodDefault') {
    const inner = (schema as unknown as { _def: { innerType: z.ZodTypeAny } })._def
      .innerType;
    return convert(inner);
  }

  if (typeName === 'ZodEffects') {
    const inner = (schema as unknown as { _def: { schema: z.ZodTypeAny } })._def
      .schema;
    return convert(inner);
  }

  if (typeName === 'ZodObject') {
    return convertObject(schema as unknown as z.ZodObject<z.ZodRawShape>);
  }

  if (typeName === 'ZodArray') {
    const inner = (schema as unknown as { _def: { type: z.ZodTypeAny } })._def
      .type;
    return { type: 'array', items: convert(inner) };
  }

  if (typeName === 'ZodString') {
    return { type: 'string' };
  }

  if (typeName === 'ZodNumber') {
    return { type: 'number' };
  }

  if (typeName === 'ZodBoolean') {
    return { type: 'boolean' };
  }

  if (typeName === 'ZodEnum') {
    const values = (schema as unknown as { _def: { values: readonly string[] } })
      ._def.values;
    return { type: 'string', enum: [...values] };
  }

  if (typeName === 'ZodLiteral') {
    const value = (
      schema as unknown as { _def: { value: string | number | boolean } }
    )._def.value;
    const t =
      typeof value === 'string'
        ? 'string'
        : typeof value === 'number'
          ? 'number'
          : 'boolean';
    return { type: t, const: value };
  }

  if (typeName === 'ZodRecord') {
    const valueType = (schema as unknown as { _def: { valueType?: z.ZodTypeAny } })
      ._def.valueType;
    const out: JsonSchema = { type: 'object' };
    if (valueType) {
      out.additionalProperties = convert(valueType);
    } else {
      out.additionalProperties = true;
    }
    return out;
  }

  if (typeName === 'ZodUnknown' || typeName === 'ZodAny') {
    return {};
  }

  // Unknown / unhandled — return a permissive empty schema so MCP still has a
  // valid shape to advertise.
  return {};
}

function convertObject(schema: z.ZodObject<z.ZodRawShape>): JsonSchema {
  const shape = schema.shape as Record<string, z.ZodTypeAny>;
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    properties[key] = convert(value);
    if (!isOptional(value)) {
      required.push(key);
    }
  }

  const out: JsonSchema = {
    type: 'object',
    properties,
    additionalProperties: false,
  };
  if (required.length > 0) {
    out.required = required;
  }
  return out;
}

function isOptional(schema: z.ZodTypeAny): boolean {
  const typeName = (schema as { _def?: { typeName?: string } })._def?.typeName;
  if (typeName === 'ZodOptional' || typeName === 'ZodDefault') return true;
  if (typeName === 'ZodEffects') {
    const inner = (schema as unknown as { _def: { schema: z.ZodTypeAny } })._def
      .schema;
    return isOptional(inner);
  }
  return false;
}

/**
 * `z.nullable` lets `null` through alongside the inner type. JSON Schema
 * expresses that as `type: [original, 'null']` when the inner has a single
 * named type.
 */
function widenForNull(schema: JsonSchema): JsonSchema {
  if (typeof schema.type === 'string') {
    return { ...schema, type: [schema.type, 'null'] };
  }
  if (Array.isArray(schema.type)) {
    if (schema.type.includes('null')) return schema;
    return { ...schema, type: [...schema.type, 'null'] };
  }
  return schema;
}
