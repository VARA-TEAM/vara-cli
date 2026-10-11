import { z } from 'zod'
import type { Mode } from '../core/types.js'

export interface ToolContext {
  cwd: string
  mode: Mode
  sessionId: string
  /** Secret scope string, e.g. `session:<id>`. */
  scope: string
  /** Environment for spawned processes (base env + injected scoped secrets). */
  env: Record<string, string>
  allowPublish: boolean
}

export interface ToolResult {
  ok: boolean
  output: string
  /** Set when the tool wants the session to pause for a user decision. */
  pauseForUser?: string
  /** Set when the model claims the objective is met; the engine then verifies. */
  completeClaim?: { summary: string; verificationPlan: string; verifiedRequirements?: string[] }
}

export interface Tool<A = unknown> {
  name: string
  description: string
  schema: z.ZodType
  /** True when the tool cannot change anything (allowed in plan mode). */
  readonly: boolean
  /** Optional extra guard: mode-independent policy (e.g. publish blocking). */
  guard?: (args: unknown, ctx: ToolContext) => string | null
  execute: (args: A, ctx: ToolContext) => Promise<ToolResult>
}

/* ---------- minimal zod -> JSON Schema conversion ---------- */

type Json = Record<string, unknown>

export function zodToJsonSchema(schema: z.ZodType, name: string): Json {
  const properties: Record<string, Json> = {}
  const required: string[] = []
  const desc = schema.description
  const inner = unwrap(schema)
  if (inner instanceof z.ZodObject) {
    for (const [key, value] of Object.entries(inner.shape)) {
      const field = value as z.ZodType
      properties[key] = { ...(fieldToSchema(field) as Json) }
      if (field.description) properties[key]!['description'] = field.description
      if (!field.isOptional()) required.push(key)
    }
  }
  return {
    type: 'function',
    function: {
      name,
      description: desc ?? '',
      parameters: { type: 'object', properties, required, additionalProperties: false },
    },
  }
}

function unwrap(schema: z.ZodType): z.ZodType {
  let s = schema
  for (;;) {
    if (s instanceof z.ZodOptional) s = s.unwrap()
    else if (s instanceof z.ZodDefault) s = s.removeDefault()
    else if (s instanceof z.ZodEffects) s = s.innerType()
    else return s
  }
}

function fieldToSchema(schema: z.ZodType): Json {
  const s = unwrap(schema)
  if (s instanceof z.ZodString) {
    const out: Json = { type: 'string' }
    if (s instanceof z.ZodString && 'checks' in s) {
      for (const check of (s as unknown as { checks: Array<{ kind: string; value?: unknown }> }).checks) {
        if (check.kind === 'min') out['minLength'] = check.value
        if (check.kind === 'max') out['maxLength'] = check.value
      }
    }
    return out
  }
  if (s instanceof z.ZodNumber) return { type: 'number' }
  if (s instanceof z.ZodBoolean) return { type: 'boolean' }
  if (s instanceof z.ZodEnum) return { type: 'string', enum: (s as z.ZodEnum<[string, ...string[]]>).options }
  if (s instanceof z.ZodArray) return { type: 'array', items: fieldToSchema(s.element as z.ZodType) }
  if (s instanceof z.ZodObject) {
    const props: Record<string, Json> = {}
    const req: string[] = []
    for (const [k, v] of Object.entries(s.shape)) {
      const field = v as z.ZodType
      props[k] = fieldToSchema(field)
      if (!field.isOptional()) req.push(k)
    }
    return { type: 'object', properties: props, required: req }
  }
  if (s instanceof z.ZodOptional) return fieldToSchema(s.unwrap())
  if (s instanceof z.ZodDefault) return fieldToSchema(s.removeDefault())
  return {}
}
