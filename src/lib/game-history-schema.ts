import { z } from 'zod'
import type { GameHistory } from './types'
import type { StoryState } from './story'
const emptyHistory = (): GameHistory => ({
  sessions: [],
  branches: [],
  nodes: [],
  contexts: [],
  messageVersions: [],
  taskVersions: [],
  slots: [],
  stateVersions: [],
})

export const personaSnapshotSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  gender: z.string(),
  identity: z.string(),
  prefer: z.string(),
  force: z.string(),
  createdAt: z.number(),
})
export const storyContentSchema = z.object({
  character: z.string(),
  rules: z.string(),
  style: z.string(),
  opening: z.string(),
  world: z.array(z.object({ label: z.string(), text: z.string() })),
  entities: z.array(
    z.object({
      id: z.string().min(1),
      kind: z.enum(['character', 'location', 'organization']),
      name: z.string(),
      description: z.string(),
    }),
  ),
  background: z.string(),
})
const id = z.string().min(1)
const object = z.record(z.string(), z.unknown())
const owned = { id, archiveId: id }
const recoverySchema = z.object({
  nodeId: id,
  contextId: id,
  stateId: id,
  messageIds: z.array(id),
  taskIds: z.array(id),
  archive: object,
})
const schema = z.object({
  sessions: z.array(
    z.object({ id, branchId: id, nodeId: id, startNodeId: id, detached: z.boolean().optional() }),
  ),
  branches: z.array(
    z.object({
      ...owned,
      name: id,
      headId: id,
      forkNodeId: id.optional(),
      createdAt: z.number(),
      recovery: recoverySchema.optional(),
    }),
  ),
  nodes: z.array(
    z.object({
      ...owned,
      branchId: id,
      parentId: id.optional(),
      createdAt: z.number(),
      label: id,
      messageIds: z.array(id),
      taskIds: z.array(id),
      contextId: id,
      stateId: id,
      archive: object,
    }),
  ),
  contexts: z.array(
    z.object({ ...owned, content: storyContentSchema, persona: personaSnapshotSchema.optional() }),
  ),
  messageVersions: z.array(z.object({ ...owned, value: object })),
  taskVersions: z.array(z.object({ ...owned, value: object })),
  stateVersions: z.array(z.object({ ...owned, state: object })).default([]),
  slots: z.array(
    z.object({
      ...owned,
      branchId: id,
      nodeId: id,
      name: id,
      kind: z.enum(['auto', 'manual', 'quick']),
      createdAt: z.number(),
      recovery: recoverySchema.optional(),
    }),
  ),
})
export function parseHistory(value: unknown, archiveIds: string[]): GameHistory {
  const h = schema.parse(value ?? emptyHistory()) as unknown as GameHistory
  const archives = new Set(archiveIds)
  for (const [key, values] of Object.entries(h)) {
    if (new Set((values as { id: string }[]).map((v) => v.id)).size !== values.length)
      throw new Error(`历史 ${key} 存在重复编号。`)
    for (const v of values as { id: string; archiveId?: string }[])
      if (!archives.has(v.archiveId ?? v.id)) throw new Error('历史资料没有所属篇章。')
  }
  const nodes = new Map(h.nodes.map((v) => [v.id, v]))
  const branches = new Map(h.branches.map((v) => [v.id, v]))
  const contexts = new Map(h.contexts.map((v) => [v.id, v]))
  const messages = new Map(h.messageVersions.map((v) => [v.id, v]))
  const tasks = new Map(h.taskVersions.map((v) => [v.id, v]))
  const states = new Map(h.stateVersions.map((v) => [v.id, v]))
  const same = (record: { archiveId: string } | undefined, archiveId: string) => {
    if (!record || record.archiveId !== archiveId) throw new Error('历史节点引用缺失或跨越篇章。')
  }
  for (const node of h.nodes) {
    same(contexts.get(node.contextId), node.archiveId)
    same(states.get(node.stateId), node.archiveId)
    if (node.archive.id !== node.archiveId) throw new Error('历史篇章编号不一致。')
    for (const key of node.messageIds) same(messages.get(key), node.archiveId)
    for (const key of node.taskIds) same(tasks.get(key), node.archiveId)
    if (
      new Set(node.messageIds.map((key) => messages.get(key)!.value.id)).size !==
        node.messageIds.length ||
      new Set(node.taskIds.map((key) => tasks.get(key)!.value.id)).size !== node.taskIds.length
    )
      throw new Error('剧情节点包含重复消息或任务。')
    const seen = new Set([node.id])
    let parent = node.parentId
    while (parent) {
      if (seen.has(parent)) throw new Error('历史节点不能构成循环。')
      seen.add(parent)
      const ancestor = nodes.get(parent)
      same(ancestor, node.archiveId)
      parent = ancestor?.parentId
    }
  }
  for (const b of h.branches) {
    same(nodes.get(b.headId), b.archiveId)
    if (b.forkNodeId) same(nodes.get(b.forkNodeId), b.archiveId)
  }
  for (const s of h.sessions) {
    same(branches.get(s.branchId), s.id)
    same(nodes.get(s.nodeId), s.id)
    same(nodes.get(s.startNodeId), s.id)
  }
  for (const s of h.slots) same(nodes.get(s.nodeId), s.archiveId)
  for (const owner of [...h.branches, ...h.slots])
    if (owner.recovery) {
      const r = owner.recovery
      same(nodes.get(r.nodeId), owner.archiveId)
      same(contexts.get(r.contextId), owner.archiveId)
      same(states.get(r.stateId), owner.archiveId)
      for (const id of r.messageIds) same(messages.get(id), owner.archiveId)
      for (const id of r.taskIds) same(tasks.get(id), owner.archiveId)
      if (r.archive.id !== owner.archiveId || ('nodeId' in owner && owner.nodeId !== r.nodeId))
        throw new Error('恢复草稿的剧情起点不一致。')
    }
  for (const v of [...h.messageVersions, ...h.taskVersions])
    if (v.value.archiveId !== v.archiveId) throw new Error('历史版本所属篇章不一致。')
  if (
    new Set(h.slots.filter((s) => s.kind === 'quick').map((s) => s.archiveId)).size !==
    h.slots.filter((s) => s.kind === 'quick').length
  )
    throw new Error('每个篇章只能有一个快速存档。')
  return h
}

export function assertSnapshotState(state: StoryState, expected: StoryState) {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, canonical(item)]),
          )
        : value
  if (
    JSON.stringify(canonical({ ...state, revision: 0 })) !==
    JSON.stringify(canonical({ ...expected, revision: 0 }))
  )
    throw new Error('状态快照与对应剧情节点不一致。')
}
