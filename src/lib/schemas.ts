import { z } from 'zod'

const text = z.string()
const object = z.strictObject

export const narrativeSchema = object({
  scene: object({
    time: text,
    location: text,
    characters: z.array(text),
    quoteZh: text,
    quoteEn: text,
    source: text,
  }),
  blocks: z.array(object({ kind: z.enum(['narration', 'dialogue']), text, translation: text })),
  state: object({
    innerVoice: text,
    desire: text,
    wishes: z.array(text),
    spokenLine: text,
    subtext: text,
  }),
  phone: object({
    memos: z.array(text),
    recommendations: z.array(object({ brand: text, item: text, reaction: text })),
    purchases: z.array(object({ item: text, price: text, reason: text })),
    conversations: z.array(
      object({ contact: text, messages: z.array(object({ speaker: text, time: text, text })) }),
    ),
  }),
  diary: object({ text, countdownDays: z.number().int().nonnegative(), explanation: text }),
})

export const forumSchema = object({
  post: object({
    id: text,
    title: text,
    author: text,
    time: text,
    content: text,
    tags: z.array(text),
    views: z.number().int().nonnegative(),
    followers: z.number().int().nonnegative(),
  }),
  answers: z.array(
    object({
      id: text,
      author: text,
      time: text,
      content: text,
      likes: z.number().int().nonnegative(),
      replyTo: text,
    }),
  ),
})

export const compressionSchema = object({
  summary: text,
  relationships: z.array(text),
  timeline: z.array(object({ time: text, location: text, event: text })),
  decisions: z.array(text),
  unfinished: z.array(text),
})

export type NarrativeReply = z.infer<typeof narrativeSchema>
export type ForumReply = z.infer<typeof forumSchema>
export type CompressionResult = z.infer<typeof compressionSchema>
export type Reply =
  { kind: 'narrative'; value: NarrativeReply } | { kind: 'forum'; value: ForumReply }
export type RequestKind = Reply['kind']

export class ContentValidationError extends Error {
  constructor(public issues: string[]) {
    super(issues.join('；'))
    this.name = 'ContentValidationError'
  }
}

const length = (value: string) => [...value.replace(/\s/g, '')].length
function nonempty(
  value: unknown,
  path = '',
  allowEmpty = new Set(['translation', 'replyTo']),
): string[] {
  if (typeof value === 'string')
    return !value.trim() && !allowEmpty.has(path.split('.').at(-1) ?? '')
      ? [`${path} 不能为空`]
      : []
  if (Array.isArray(value)) return value.flatMap((v, i) => nonempty(v, `${path}.${i}`, allowEmpty))
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([k, v]) =>
      nonempty(v, path ? `${path}.${k}` : k, allowEmpty),
    )
  return []
}

export function validateNarrative(input: unknown): NarrativeReply {
  const result = narrativeSchema.safeParse(input)
  if (!result.success)
    throw new ContentValidationError(
      result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    )
  const v = result.data
  const issues = nonempty(v)
  if (!v.scene.characters.length) issues.push('场景人物至少 1 位')
  if (length(v.scene.quoteZh) < 30 || length(v.scene.quoteZh) > 50)
    issues.push('中文引语须为 30–50 字')
  const words = v.scene.quoteEn.trim().split(/\s+/).length
  if (words < 10 || words > 20) issues.push('英文引语须为 10–20 个词')
  if (length(v.blocks.map((b) => b.text).join('')) < 750) issues.push('正文至少 750 字')
  if (!v.blocks.some((b) => b.kind === 'dialogue')) issues.push('正文须有方言对白')
  if (v.blocks.some((b) => b.kind === 'dialogue' && !b.translation.trim()))
    issues.push('方言对白须有普通话翻译')
  if (length(v.state.innerVoice) < 100) issues.push('心声至少 100 字')
  if (v.state.wishes.length < 3) issues.push('当前最想做至少 3 条')
  if (!v.blocks.some((b) => b.text.includes(v.state.spokenLine)))
    issues.push('正文中的一句话须来自本轮正文')
  if (v.phone.memos.length < 5) issues.push('备忘录至少 5 条')
  if (v.phone.memos.some((m) => length(m) < 20 || length(m) > 40))
    issues.push('每条备忘录须为 20–40 字')
  if (v.phone.recommendations.length < 5) issues.push('推送至少 5 条')
  if (v.phone.purchases.length < 5) issues.push('购买记录至少 5 条')
  if (
    v.phone.purchases.some(
      (p) =>
        length(`${p.item}${p.price}${p.reason}`) < 30 ||
        length(`${p.item}${p.price}${p.reason}`) > 60,
    )
  )
    issues.push('每条购买记录须为 30–60 字')
  if (
    v.phone.conversations.length !== 3 ||
    v.phone.conversations.some((c) => c.messages.length !== 4)
  )
    issues.push('微信须为 3 组，每组 4 条消息')
  if (length(v.diary.text) < 300) issues.push('日记至少 300 字')
  if (issues.length) throw new ContentValidationError(issues)
  return v
}

export function validateForum(input: unknown): ForumReply {
  const result = forumSchema.safeParse(input)
  if (!result.success)
    throw new ContentValidationError(
      result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    )
  const issues = nonempty(result.data)
  if (result.data.answers.length !== 50) issues.push('论坛须完整包含 50 条回答')
  if (new Set(result.data.answers.map((a) => a.id)).size !== result.data.answers.length)
    issues.push('回答 ID 不得重复')
  if (issues.length) throw new ContentValidationError(issues)
  return result.data
}

export function validateCompression(input: unknown): CompressionResult {
  const v = compressionSchema.parse(input)
  const issues = nonempty(v, '', new Set())
  if (issues.length) throw new ContentValidationError(issues)
  return v
}
