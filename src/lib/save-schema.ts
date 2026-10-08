import { z } from 'zod'
import { compressionSchema, forumSchema, narrativeSchema, sanitizePartial } from './schemas'
import type { SaveFile, StoredMessage } from './types'

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
export const capabilitySchema = z.object({
  fingerprint: z.string(),
  testedAt: timestamp,
  ok: z.boolean(),
  error: z.string().optional(),
  streaming: z.boolean().optional(),
  protocols: z.boolean().optional(),
  firstTokenMs: z.number().nonnegative().optional(),
  elapsedMs: z.number().nonnegative().optional(),
})
const diagnosticsSchema = z.object({
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
const legacySchema = z.object({
  body: z.string(),
  scene: z
    .object({
      time: z.string(),
      location: z.string(),
      characters: z.string(),
      quoteZh: z.string(),
      quoteEn: z.string(),
      source: z.string(),
    })
    .optional(),
  panels: z.array(
    z.object({
      title: z.string(),
      sections: z.array(z.object({ heading: z.string(), text: z.string() })),
    }),
  ),
  // Old forum exports may predate the 50-answer protocol.
  forum: forumSchema.optional(),
})

export const storedMessageSchema: z.ZodType<StoredMessage> = z.object({
  id,
  archiveId: id,
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  createdAt: timestamp,
  sequence: count,
  kind: z.enum(['narrative', 'forum', 'legacy', 'notice']),
  status: z.enum(['complete', 'partial', 'failed', 'cancelled']),
  reply: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('narrative'), value: narrativeSchema }),
      z.object({ kind: z.literal('forum'), value: forumSchema }),
    ])
    .optional(),
  partial: z
    .discriminatedUnion('kind', [
      z.object({
        kind: z.literal('narrative'),
        value: z
          .record(z.string(), z.unknown())
          .transform((value) => sanitizePartial('narrative', value)),
      }),
      z.object({
        kind: z.literal('forum'),
        value: z
          .record(z.string(), z.unknown())
          .transform((value) => sanitizePartial('forum', value)),
      }),
    ])
    .optional(),
  legacy: legacySchema.optional(),
  rawContent: z.string().optional(),
  correction: z.string().optional(),
  error: z.string().optional(),
  usage: usageSchema.optional(),
  diagnostics: diagnosticsSchema.optional(),
})

export const saveFileSchema: z.ZodType<SaveFile> = z.object({
  version: z.literal(2),
  exportedAt: z.iso.datetime(),
  archives: z.array(
    z.object({
      id,
      name: z.string(),
      createdAt: timestamp,
      updatedAt: timestamp,
      revision: count,
      draft: z.string(),
      summary: z
        .object({
          value: compressionSchema,
          coveredThroughId: id,
          coveredCount: count,
          revision: count,
          createdAt: timestamp,
        })
        .optional(),
      lastUsage: usageSchema.optional(),
      compactionError: z.string().optional(),
    }),
  ),
  messages: z.array(storedMessageSchema),
  channels: z.array(
    z
      .object({
        id,
        name: z.string(),
        baseUrl: z.string(),
        apiKey: z.string(),
        model: z.string(),
        temperature: z.number().min(0).max(2),
        maxOutputTokens: z.number().int().min(128),
        contextWindow: z.number().int().min(1024),
        requestTimeoutMs: z.number().int().nonnegative().optional(),
        createdAt: timestamp,
        capability: capabilitySchema.optional(),
        calibration: calibrationSchema.optional(),
      })
      .refine((channel) => channel.maxOutputTokens < channel.contextWindow, {
        path: ['maxOutputTokens'],
        message: '输出上限必须小于上下文容量',
      }),
  ),
  masks: z.array(
    z.object({
      id,
      name: z.string(),
      gender: z.string(),
      identity: z.string(),
      prefer: z.string(),
      force: z.string(),
      createdAt: timestamp,
    }),
  ),
  settings: z.object({
    id: z.literal('app'),
    activeChannelId: z.string(),
    activePersonaId: z.string(),
    activeArchiveId: z.string(),
    migrated: z.boolean(),
    fontChat: z.number().min(10).max(24),
    fontUi: z.number().min(10).max(18),
    fontFamily: z.string(),
    bgImage: z.string(),
    bgOpacity: z.number().min(0).max(100),
  }),
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
