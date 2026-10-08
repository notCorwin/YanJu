import { z } from 'zod'

const text = z.string()
const nullable = text.nullable()
const object = z.strictObject
const origin = { sourceBlockId: nullable }

export const effectsSchema = object({
  entities: z.array(
    object({
      ref: text,
      kind: z.enum(['character', 'location', 'organization']),
      name: text,
      description: text,
      ...origin,
    }),
  ),
  states: z.array(object({ entityRef: text, key: text, value: text, ...origin })),
  relationships: z.array(
    object({ ref: text, from: text, to: text, type: text, description: text, ...origin }),
  ),
  knowledge: z.array(object({ ref: text, entityRef: text, fact: text, ...origin })),
  events: z.array(
    object({
      ref: text,
      title: text,
      time: nullable,
      locationRef: nullable,
      participants: z.array(text),
      description: text,
      ...origin,
    }),
  ),
  memories: z.array(
    object({
      ref: text,
      kind: z.enum(['fact', 'preference']),
      content: text,
      entityRefs: z.array(text),
      status: z.enum(['active', 'retracted']),
      ...origin,
    }),
  ),
  goals: z.array(
    object({
      ref: text,
      ownerRef: text,
      description: text,
      dueDate: nullable,
      status: z.enum(['open', 'done', 'cancelled']),
      ...origin,
    }),
  ),
  clock: object({ dateTime: nullable, proposalDate: nullable }),
})

export type TurnEffects = z.infer<typeof effectsSchema>
export interface SourceRef {
  messageId: string
  blockId: string | null
}
export const emptyEffects = (): TurnEffects => ({
  entities: [],
  states: [],
  relationships: [],
  knowledge: [],
  events: [],
  memories: [],
  goals: [],
  clock: { dateTime: null, proposalDate: null },
})

export function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}
export function validDateTime(value: string) {
  return (
    validDate(value.slice(0, 10)) &&
    /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(
      value,
    ) &&
    Number.isFinite(Date.parse(value))
  )
}
export function countdown(clock: TurnEffects['clock']) {
  if (!clock.dateTime || !clock.proposalDate) return null
  return Math.max(
    0,
    Math.round(
      (Date.parse(`${clock.proposalDate}T00:00:00Z`) -
        Date.parse(`${clock.dateTime.slice(0, 10)}T00:00:00Z`)) /
        86400000,
    ),
  )
}
