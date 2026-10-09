import { z } from 'zod'
import { apiProtocols, outputModes } from './types'

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
export const apiProtocolSchema = z.enum(apiProtocols)
export const outputModeSchema = z.enum(outputModes)
const protocolCapabilitySchema = z.object({
  nonStreaming: z.enum(['passed', 'failed', 'untested']),
  streaming: z.enum(['passed', 'failed', 'untested']),
  error: z.string().optional(),
  outputMode: outputModeSchema.optional(),
  streamingOutputMode: outputModeSchema.optional(),
})
export const capabilitySchema = z.object({
  fingerprint: z.string(),
  catalogFingerprint: z.string().optional(),
  testedAt: timestamp,
  ok: z.boolean(),
  error: z.string().optional(),
  protocol: apiProtocolSchema.optional(),
  checks: z.partialRecord(apiProtocolSchema, protocolCapabilitySchema).optional(),
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
  outputMode: outputModeSchema.optional(),
  fallbacks: count.optional(),
  repairs: count.optional(),
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
