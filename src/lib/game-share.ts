import { z } from 'zod'
import { captureRecovery, emptyHistory, historyFor, putHistory } from './game-history'
import { parseHistory, assertSnapshotState } from './game-history-schema'
import { db } from './storage/database'
import { normalizeImport } from './storage/serialization'
import { remapReferences, remapMessage } from './storage/references'
import { rebuildStory } from './story'
import {
  defaults,
  type Archive,
  type GameHistory,
  type HistoryNode,
  type RecoveryState,
  type SaveFile,
  type StoredMessage,
  type TaskRun,
} from './types'
import { withImportOperation } from './operations'

export interface SharePackage {
  format: 'yanju-game'
  version: 1
  mode: 'start' | 'progress'
  scope: 'route' | 'game'
  name: string
  history: GameHistory
}
const cleanArchive = (a: Archive): Archive => ({
  id: a.id,
  name: a.name,
  createdAt: a.createdAt,
  updatedAt: a.updatedAt,
  revision: a.revision,
  draft: a.draft,
  userName: a.userName,
  description: a.description,
  keywords: a.keywords,
  summary: a.summary,
  deletedMessageIds: a.deletedMessageIds,
})
const cleanMessage = (m: StoredMessage): StoredMessage => ({
  id: m.id,
  archiveId: m.archiveId,
  role: m.role,
  content: m.content,
  createdAt: m.createdAt,
  sequence: m.sequence,
  kind: m.kind,
  status: m.status === 'partial' ? 'cancelled' : m.status,
  reply: m.reply,
  partial: m.partial,
  stale: m.stale,
  effects: m.effects,
  userName: m.userName,
  interaction: m.interaction,
})
function cleanTask(t: TaskRun): TaskRun {
  const { context } = t.input
  // An empty runtime binding is omitted from the serialized package, and rebound on retry.
  return {
    id: t.id,
    archiveId: t.archiveId,
    revision: t.revision,
    kind: t.kind,
    input: {
      text: t.input.text,
      targetId: t.input.targetId,
      context: {
        archive: context.archive,
        persona: context.persona,
        setting: context.setting,
        story: context.story,
        target: context.target,
        phone: context.phone,
        forum: context.forum,
        archives: [{ id: t.archiveId, name: context.archive.name }],
        tracks: context.tracks,
        history: context.history,
      },
    },
    channelId: undefined as unknown as string,
    createdAt: t.createdAt,
    status: t.status === 'partial' ? 'cancelled' : t.status,
    output: t.output,
    partial: t.partial,
    applied: t.applied,
  }
}
function portable(history: GameHistory): GameHistory {
  const cleanRecovery = (r?: RecoveryState) => r && { ...r, archive: cleanArchive(r.archive) }
  return {
    ...history,
    branches: history.branches.map((b) => ({ ...b, recovery: cleanRecovery(b.recovery) })),
    slots: history.slots.map((s) => ({ ...s, recovery: cleanRecovery(s.recovery) })),
    nodes: history.nodes.map((n) => ({ ...n, archive: cleanArchive(n.archive) })),
    messageVersions: history.messageVersions.map((v) => ({ ...v, value: cleanMessage(v.value) })),
    taskVersions: history.taskVersions.map((v) => ({ ...v, value: cleanTask(v.value) })),
  }
}
export async function exportGame(
  archiveId: string,
  mode: SharePackage['mode'] = 'progress',
  scope: SharePackage['scope'] = 'route',
): Promise<SharePackage> {
  return db.transaction('rw', [...db.gameTables, db.archives, db.messages, db.tasks], async () => {
    const archive = await db.archives.get(archiveId)
    if (!archive) throw new Error('篇章已删除。')
    const recovery = await captureRecovery(archiveId)
    const all = await historyFor()
    const session = all.sessions.find((s) => s.id === archiveId)!
    const targetId = mode === 'start' ? session.startNodeId : session.nodeId
    const nodes = new Map(all.nodes.filter((n) => n.archiveId === archiveId).map((n) => [n.id, n]))
    const included = new Set<string>()
    const include = (id: string) => {
      let node = nodes.get(id)
      while (node && !included.has(node.id)) {
        included.add(node.id)
        node = node.parentId ? nodes.get(node.parentId) : undefined
      }
    }
    include(targetId)
    const whole = mode === 'progress' && scope === 'game'
    if (whole) include(session.startNodeId)
    const branches = all.branches.filter(
      (b) => b.archiveId === archiveId && (whole || b.id === session.branchId),
    )
    if (whole) {
      branches.forEach((b) => {
        include(b.headId)
        if (b.recovery) include(b.recovery.nodeId)
      })
      all.slots.filter((s) => s.archiveId === archiveId).forEach((s) => include(s.nodeId))
    }
    const slots =
      mode === 'start'
        ? []
        : all.slots.filter(
            (s) =>
              s.archiveId === archiveId &&
              included.has(s.nodeId) &&
              (whole || s.branchId === session.branchId),
          )
    const recoveries = [
      ...(mode === 'progress' ? [recovery] : []),
      ...slots.flatMap((s) => (s.recovery ? [s.recovery] : [])),
      ...(whole ? branches.flatMap((b) => (b.recovery ? [b.recovery] : [])) : []),
    ]
    const selected = [...nodes.values()].filter((n) => included.has(n.id))
    const contextIds = new Set([...selected, ...recoveries].map((n) => n.contextId))
    const messageIds = new Set([...selected, ...recoveries].flatMap((n) => n.messageIds))
    const stateIds = new Set([...selected, ...recoveries].map((n) => n.stateId))
    const taskIds = new Set([...selected, ...recoveries].flatMap((n) => n.taskIds))
    const branchId = branches.find((b) => b.id === session.branchId)?.id ?? crypto.randomUUID()
    const history: GameHistory = {
      sessions: [
        {
          ...session,
          branchId,
          nodeId: targetId,
          detached: whole ? session.detached : undefined,
          startNodeId: included.has(session.startNodeId)
            ? session.startNodeId
            : (selected.find((n) => !n.parentId)?.id ?? targetId),
        },
      ],
      branches: whole
        ? branches
        : [
            {
              id: branchId,
              archiveId,
              name: mode === 'start' ? '开局' : '分享路线',
              headId: targetId,
              recovery: mode === 'progress' ? recovery : undefined,
              createdAt: Date.now(),
            },
          ],
      nodes: selected,
      contexts: all.contexts.filter((v) => contextIds.has(v.id)),
      messageVersions: all.messageVersions.filter((v) => messageIds.has(v.id)),
      taskVersions: all.taskVersions.filter((v) => taskIds.has(v.id)),
      slots,
      stateVersions: all.stateVersions.filter((v) => stateIds.has(v.id)),
    }
    return {
      format: 'yanju-game',
      version: 1,
      name: archive.name,
      mode,
      scope: whole ? 'game' : 'route',
      history: portable(history),
    }
  })
}
export function parseGameShare(input: unknown): SharePackage {
  const envelope = z
    .object({
      format: z.literal('yanju-game'),
      version: z.literal(1),
      mode: z.enum(['start', 'progress']),
      scope: z.enum(['route', 'game']),
      name: z.string().min(1),
      history: z.unknown(),
    })
    .parse(input)
  const raw = z
    .object({ sessions: z.array(z.object({ id: z.string() })).length(1) })
    .parse(envelope.history)
  const h = portable(
    parseHistory(
      envelope.history,
      raw.sessions.map((s) => s.id),
    ),
  )
  // Validate every reachable snapshot before any transaction can touch the receiver's data.
  for (const node of h.nodes) snapshotSave(h, node)
  for (const owner of [...h.branches, ...h.slots])
    if (owner.recovery)
      snapshotSave(
        h,
        h.nodes.find((n) => n.id === owner.recovery!.nodeId)!,
        owner.recovery,
      )
  return { ...envelope, history: h }
}
function snapshotSave(history: GameHistory, base: HistoryNode, recovery?: RecoveryState): SaveFile {
  const node = recovery ? { ...base, ...recovery } : base
  const context = history.contexts.find((c) => c.id === node.contextId)!
  const archive = { ...node.archive, content: context.content, persona: context.persona }
  const messages = node.messageIds.map(
    (id) => history.messageVersions.find((v) => v.id === id)!.value,
  )
  const tasks = node.taskIds.map((id) => ({
    ...history.taskVersions.find((v) => v.id === id)!.value,
    channelId: 'unassigned',
  }))
  const data = normalizeImport({
    version: 4,
    archives: [archive],
    messages,
    tasks,
    channels: [],
    masks: [],
    storyStates: [],
    storyEvents: [],
    requests: [],
    settings: { ...defaults, activeArchiveId: archive.id },
    history: emptyHistory(),
  })
  assertSnapshotState(
    history.stateVersions.find((v) => v.id === node.stateId)!.state,
    data.storyStates[0],
  )
  return data
}
export async function importGame(input: unknown) {
  const pkg = parseGameShare(input)
  const ids = new Map<string, string>()
  for (const collection of Object.values(pkg.history))
    for (const value of collection) {
      ids.set(value.id, crypto.randomUUID())
      if ('value' in value) ids.set(value.value.id, crypto.randomUUID())
    }
  for (const context of pkg.history.contexts)
    if (context.persona) ids.set(context.persona.id, crypto.randomUUID())
  for (const record of [...pkg.history.nodes, ...pkg.history.slots])
    if (!ids.has(record.branchId)) ids.set(record.branchId, crypto.randomUUID())
  const history = remapReferences(pkg.history, ids)
  history.messageVersions = pkg.history.messageVersions.map((v) => ({
    ...remapReferences(v, ids),
    value: remapMessage(v.value, ids),
  }))
  const session = history.sessions[0]
  const node = history.nodes.find((n) => n.id === session.nodeId)!
  const recovery = history.branches.find((b) => b.id === session.branchId)?.recovery
  const data = snapshotSave(history, node, recovery?.nodeId === node.id ? recovery : undefined)
  const archive = { ...data.archives[0], name: pkg.name, navigationEpoch: 0 }
  await withImportOperation(() =>
    db.transaction(
      'rw',
      [...db.gameTables, db.archives, db.messages, db.tasks, db.storyStates, db.storyEvents],
      async () => {
        await putHistory(history)
        await db.archives.add(archive)
        await db.messages.bulkAdd(data.messages)
        await db.tasks.bulkAdd(data.tasks)
        const projection = rebuildStory(archive, data.messages)
        await db.storyStates.put(projection.story)
        await db.storyEvents.bulkPut(projection.events)
      },
    ),
  )
  await db.persistence.flush()
  return archive
}
