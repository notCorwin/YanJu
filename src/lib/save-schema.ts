import { z } from 'zod'

const id = z.string().min(1)
const timestamp = z.number().int().min(0).max(8_640_000_000_000_000)
const count = z.number().int().nonnegative()

export const usageSchema = z.object({
  input: count,
  output: count,
  total: count,
  measuredAt: timestamp,
  estimatedInput: count,
  channelId: id,
})
export const calibrationSchema = z.object({ ratio: z.number().min(0.5).max(4), samples: count })
const protocolSchema = z.enum(['responses', 'chat-completions', 'native'])
const protocolCapabilitySchema = z.object({
  nonStreaming: z.enum(['passed', 'failed', 'untested']),
  streaming: z.enum(['passed', 'failed', 'untested']),
  error: z.string().optional(),
})
export const capabilitySchema = z.object({
  fingerprint: z.string(),
  testedAt: timestamp,
  ok: z.boolean(),
  error: z.string().optional(),
  protocol: protocolSchema.optional(),
  checks: z
    .object({
      native: protocolCapabilitySchema.optional(),
      responses: protocolCapabilitySchema.optional(),
      'chat-completions': protocolCapabilitySchema.optional(),
    })
    .optional(),
  protocols: z.boolean().optional(),
  firstTokenMs: z.number().nonnegative().optional(),
  elapsedMs: z.number().nonnegative().optional(),
})
export const diagnosticsSchema = z.object({
  startedAt: timestamp,
  elapsedMs: z.number().nonnegative(),
  firstTokenMs: z.number().nonnegative().optional(),
  requestId: z.string().optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  corrections: count,
  model: z.string(),
  schema: z.string(),
  finishReason: z.string().optional(),
})
export function parseSave<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success)
    throw new Error(
      `存档字段不完整或无效：${result.error.issues
        .map((issue) => `${issue.path.join('.') || '文件'}：${issue.message}`)
        .join('；')}`,
    )
  return result.data
}
