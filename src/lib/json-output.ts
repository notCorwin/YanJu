import { APICallError } from 'ai'
import { UnsupportedFunctionalityError } from '@ai-sdk/provider'
import { jsonrepair } from 'jsonrepair'
import { z } from 'zod'
import { ContentValidationError } from './schemas'

/** Repair syntax and unambiguous schema values without inventing narrative content. */
export function repairJsonOutput(raw: string, schema: Record<string, unknown>): unknown {
  let text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  const start = text.indexOf('{')
  if (start > 0) text = text.slice(start)
  const value: unknown = JSON.parse(jsonrepair(text))
  return repairValue(value, schema)
}

function repairValue(value: unknown, schema: Record<string, unknown>): unknown {
  const variants = schema.anyOf ?? schema.oneOf
  if (Array.isArray(variants)) {
    if (value == null && variants.some((s) => s.type === 'null')) return null
    const matching = variants.find((s) =>
      s.type === 'object'
        ? value && typeof value === 'object' && !Array.isArray(value)
        : s.type === 'array'
          ? Array.isArray(value)
          : typeof value === s.type,
    )
    return matching ? repairValue(value, matching) : value
  }
  if (value === undefined) {
    if (schema.type === 'null' || (Array.isArray(schema.type) && schema.type.includes('null')))
      return null
    if (schema.type === 'array' && !schema.minItems) return []
    return undefined
  }
  if (
    (schema.type === 'number' || schema.type === 'integer') &&
    typeof value === 'string' &&
    /^-?\d+(?:\.\d+)?$/.test(value)
  ) {
    const numeric = Number(value)
    if (Number.isFinite(numeric) && (schema.type !== 'integer' || Number.isInteger(numeric)))
      return numeric
  }
  if (schema.type === 'boolean' && (value === 'true' || value === 'false')) return value === 'true'
  if (
    Array.isArray(value) &&
    schema.type === 'array' &&
    schema.items &&
    typeof schema.items === 'object'
  )
    return value.map((item) => repairValue(item, schema.items as Record<string, unknown>))
  if (value && typeof value === 'object' && !Array.isArray(value) && schema.type === 'object') {
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined
    if (!properties) return value
    const input = value as Record<string, unknown>
    const output =
      schema.additionalProperties === false ? ({} as Record<string, unknown>) : { ...input }
    for (const [key, child] of Object.entries(properties)) {
      const next = repairValue(input[key], child)
      if (next !== undefined) output[key] = next
    }
    return output
  }
  return value
}

export function validationDetails(error: unknown) {
  if (error instanceof z.ZodError)
    return error.issues
      .map((issue) => `${issue.path.join('.') || '根对象'}：${issue.message}`)
      .join('；')
  if (error instanceof ContentValidationError) return error.issues.join('；')
  return error instanceof Error ? error.message : String(error)
}

/** Auth, rate limits, network failures, and invalid content must never trigger a format downgrade. */
export function unsupportedOutputFormat(error: unknown) {
  for (let cause = error, depth = 0; cause && depth < 10; depth++) {
    if (UnsupportedFunctionalityError.isInstance(cause))
      return /json|response.?format|schema|structured/i.test(cause.message)
    if (APICallError.isInstance(cause)) {
      if (![400, 404, 415, 422, 501].includes(cause.statusCode ?? 0)) return false
      const message = `${cause.message} ${cause.responseBody ?? ''}`
      return (
        /json_schema|json_object|response.?format|responseMimeType|responseJsonSchema|output.?config|output.?format|structured.?output|strict|schema/i.test(
          message,
        ) &&
        /unsupported|not.support|not.available|not.allowed|unknown|unrecognized|invalid|extra|unexpected|not.permitted|not.implemented|does.not|must.be|not.accept|不支持|无效/i.test(
          message,
        )
      )
    }
    cause = cause && typeof cause === 'object' && 'cause' in cause ? cause.cause : undefined
  }
  return false
}
