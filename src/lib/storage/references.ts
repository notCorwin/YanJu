import { type StoredMessage } from '@/lib/types'

export function remapId(value: string, ids: Map<string, string>): string {
  if (ids.has(value)) return ids.get(value)!
  const prefix = [...ids.keys()]
    .sort((a, b) => b.length - a.length)
    .find((id) => value.startsWith(`${id}:`))
  return prefix ? `${ids.get(prefix)}${value.slice(prefix.length)}` : value
}

export function remapReferences<T>(value: T, ids: Map<string, string>, key = ''): T {
  if (typeof value === 'string') {
    return (
      /^(id|ref|.*Id|.*Ids|.*Ref|.*Refs|replyTo|participants|from|to|coveredThroughId)$/.test(key)
        ? remapId(value, ids)
        : value
    ) as T
  }
  if (Array.isArray(value)) return value.map((item) => remapReferences(item, ids, key)) as T
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([field, item]) => [field, remapReferences(item, ids, field)]),
    ) as T
  return value
}

export function remapContext(context: string, ids: Map<string, string>) {
  try {
    return JSON.stringify(remapReferences(JSON.parse(context) as unknown, ids))
  } catch {
    return context
  }
}

export function remapMessage(message: StoredMessage, ids: Map<string, string>) {
  const next = remapReferences(message, ids)
  if (next.reply) next.content = JSON.stringify(next.reply.value)
  if (message.requestContext) next.requestContext = remapContext(message.requestContext, ids)
  return next
}
