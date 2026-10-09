import { stopGameOperations } from './game-operations'
import type {
  Archive,
  Branch,
  GameHistory,
  HistoryNode,
  MessageVersion,
  Persona,
  RecoveryState,
  SaveSlot,
  StoryContent,
  TaskVersion,
} from './types'
import { defaultStoryContent } from './game-content'
import { db, type YanJuDatabase } from './storage/database'
import { rebuildStory } from './story'
import { withArchiveOperation, withSnapshotOperation } from './operations'

export const emptyHistory = (): GameHistory => ({
  sessions: [],
  branches: [],
  nodes: [],
  contexts: [],
  messageVersions: [],
  taskVersions: [],
  slots: [],
  stateVersions: [],
})

async function versions<T extends MessageVersion | TaskVersion>(
  table: YanJuDatabase['messageVersions'] | YanJuDatabase['taskVersions'],
  values: T['value'][],
  previousIds: string[],
  archiveId: string,
) {
  const previous = (await table.bulkGet(previousIds)) as (T | undefined)[]
  const byId = new Map(previous.filter((v): v is T => !!v).map((v) => [v.value.id, v]))
  const ids: string[] = []
  for (const value of values) {
    const old = byId.get(value.id)
    if (old && JSON.stringify(old.value) === JSON.stringify(value)) ids.push(old.id)
    else {
      const id = crypto.randomUUID()
      await table.put({ id, archiveId, value } as MessageVersion & TaskVersion)
      ids.push(id)
    }
  }
  return ids
}

async function captureState(
  database: YanJuDatabase,
  archive: Archive,
  messages: import('./types').StoredMessage[],
  previousId?: string,
) {
  const state = rebuildStory(archive, messages).story
  const previous = previousId ? await database.stateVersions.get(previousId) : undefined
  if (
    previous &&
    JSON.stringify({ ...previous.state, revision: 0 }) === JSON.stringify({ ...state, revision: 0 })
  )
    return previous.id
  const id = crypto.randomUUID()
  await database.stateVersions.add({ id, archiveId: archive.id, state })
  return id
}

/** Called inside the same transaction as the current-state projection. */
export async function captureGameNode(
  database: YanJuDatabase,
  archive: Archive,
  label = '剧情进度',
  force = false,
) {
  let session = await database.sessions.get(archive.id)
  if (session && force && !['设定与人设', '编辑剧情', '剧情修改'].includes(label))
    return session.nodeId
  const messages = await database.messages.where('archiveId').equals(archive.id).sortBy('sequence')
  const last = messages.at(-1)
  if (
    session &&
    !force &&
    (!last || last.status !== 'complete' || (last.role === 'user' && !last.effects))
  )
    return session.nodeId
  const tasks = await database.tasks.where('archiveId').equals(archive.id).toArray()
  const previous = session ? await database.nodes.get(session.nodeId) : undefined
  const oldContext = previous ? await database.contexts.get(previous.contextId) : undefined
  const contextValue = {
    content: archive.content ?? defaultStoryContent(),
    persona: archive.persona,
  }
  let contextId = oldContext?.id
  if (
    !oldContext ||
    JSON.stringify({ content: oldContext.content, persona: oldContext.persona }) !==
      JSON.stringify(contextValue)
  ) {
    contextId = crypto.randomUUID()
    await database.contexts.add({ id: contextId, archiveId: archive.id, ...contextValue })
  }
  const messageIds = await versions(
    database.messageVersions,
    messages,
    previous?.messageIds ?? [],
    archive.id,
  )
  const taskIds = await versions(database.taskVersions, tasks, previous?.taskIds ?? [], archive.id)
  const snapshot = { ...archive }
  delete snapshot.content
  delete snapshot.persona
  // Operational epochs must remain monotonic when loading an old save.
  delete snapshot.navigationEpoch
  if (
    previous &&
    contextId === previous.contextId &&
    JSON.stringify(messageIds) === JSON.stringify(previous.messageIds) &&
    (label !== '剧情修改' || JSON.stringify(taskIds) === JSON.stringify(previous.taskIds)) &&
    snapshot.name === previous.archive.name &&
    snapshot.description === previous.archive.description &&
    JSON.stringify(snapshot.keywords) === JSON.stringify(previous.archive.keywords)
  )
    return previous.id
  let branch = session ? await database.branches.get(session.branchId) : undefined
  const nodeId = crypto.randomUUID()
  if (!branch || (session && (branch.headId !== session.nodeId || session.detached))) {
    const count = await database.branches.where('archiveId').equals(archive.id).count()
    branch = {
      id: crypto.randomUUID(),
      archiveId: archive.id,
      name: count ? `路线 ${count + 1}` : '主线',
      headId: nodeId,
      forkNodeId: session?.nodeId,
      createdAt: Date.now(),
    }
    await database.branches.add(branch)
  }
  const node: HistoryNode = {
    id: nodeId,
    archiveId: archive.id,
    branchId: branch.id,
    parentId: previous?.id,
    contextId: contextId!,
    messageIds,
    taskIds,
    archive: snapshot,
    stateId: await captureState(database, archive, messages, previous?.stateId),
    createdAt: Date.now(),
    label: previous
      ? label === '剧情进度'
        ? last?.reply?.kind === 'narrative'
          ? `${last.reply.value.scene.time} · ${last.reply.value.blocks[0]?.text.slice(0, 24) ?? '剧情进度'}`
          : last?.reply?.kind === 'forum'
            ? last.reply.value.post.title
            : last?.content.slice(0, 30) || label
        : label
      : '原始开局',
  }
  await database.nodes.add(node)
  await database.branches.update(branch.id, { headId: nodeId })
  await database.branches.update(branch.id, { recovery: undefined })
  session = {
    id: archive.id,
    branchId: branch.id,
    nodeId,
    startNodeId: session?.startNodeId ?? nodeId,
  }
  await database.sessions.put(session)
  if (!force || !previous || ['设定与人设', '编辑剧情', '剧情修改'].includes(label)) {
    await database.slots.add({
      id: crypto.randomUUID(),
      archiveId: archive.id,
      branchId: branch.id,
      nodeId,
      name: node.label,
      kind: 'auto',
      createdAt: node.createdAt,
    })
    const autos = (
      await database.slots.where('[branchId+kind]').equals([branch.id, 'auto']).sortBy('createdAt')
    ).reverse()
    await database.slots.bulkDelete(autos.slice(20).map((slot) => slot.id))
  }
  return nodeId
}

/** Drafts, interrupted turns and unapplied tasks never advance the formal story cursor. */
export async function captureRecovery(archiveId: string, database = db): Promise<RecoveryState> {
  const archive = (await database.archives.get(archiveId))!
  const nodeId = await captureGameNode(database, archive, '恢复草稿', true)
  const node = (await database.nodes.get(nodeId))!
  const oldContext = (await database.contexts.get(node.contextId))!
  const contextValue = {
    content: archive.content ?? defaultStoryContent(),
    persona: archive.persona,
  }
  let contextId = oldContext.id
  if (
    JSON.stringify({ content: oldContext.content, persona: oldContext.persona }) !==
    JSON.stringify(contextValue)
  ) {
    contextId = crypto.randomUUID()
    await database.contexts.add({ id: contextId, archiveId, ...contextValue })
  }
  const snapshot = { ...archive }
  delete snapshot.content
  delete snapshot.persona
  delete snapshot.navigationEpoch
  const recovery = {
    nodeId,
    contextId,
    stateId: await captureState(
      database,
      archive,
      await database.messages.where('archiveId').equals(archiveId).sortBy('sequence'),
      node.stateId,
    ),
    archive: snapshot,
    messageIds: await versions(
      database.messageVersions,
      await database.messages.where('archiveId').equals(archiveId).sortBy('sequence'),
      node.messageIds,
      archiveId,
    ),
    taskIds: await versions(
      database.taskVersions,
      await database.tasks.where('archiveId').equals(archiveId).toArray(),
      node.taskIds,
      archiveId,
    ),
  }
  const session = (await database.sessions.get(archiveId))!
  const branch = await database.branches.get(session.branchId)
  if (branch?.headId === session.nodeId && !session.detached)
    await database.branches.update(session.branchId, { recovery })
  return recovery
}

export async function historyFor(database = db): Promise<GameHistory> {
  const [sessions, branches, nodes, contexts, messageVersions, taskVersions, slots, stateVersions] =
    await Promise.all(database.historyTables.map((table) => table.toArray()))
  const alive = new Set(await database.archives.toCollection().primaryKeys())
  const history = {
    sessions,
    branches,
    nodes,
    contexts,
    messageVersions,
    taskVersions,
    slots,
    stateVersions,
  } as GameHistory
  history.sessions = history.sessions.filter((s) => alive.has(s.id))
  history.branches = history.branches.filter((v) => alive.has(v.archiveId))
  history.nodes = history.nodes.filter((v) => alive.has(v.archiveId))
  history.contexts = history.contexts.filter((v) => alive.has(v.archiveId))
  history.messageVersions = history.messageVersions.filter((v) => alive.has(v.archiveId))
  history.taskVersions = history.taskVersions.filter((v) => alive.has(v.archiveId))
  history.slots = history.slots.filter((v) => alive.has(v.archiveId))
  history.stateVersions = history.stateVersions.filter((v) => alive.has(v.archiveId))
  return history
}
export async function putHistory(history: GameHistory, database = db, replace = false) {
  for (const [index, table] of database.historyTables.entries()) {
    if (replace) await table.clear()
    await table.bulkPut(
      history[
        (
          [
            'sessions',
            'branches',
            'nodes',
            'contexts',
            'messageVersions',
            'taskVersions',
            'slots',
            'stateVersions',
          ] as const
        )[index]
      ],
    )
  }
}
export async function removeGameHistory(archiveId: string, database = db) {
  await database.sessions.delete(archiveId)
  for (const table of database.historyTables.slice(1))
    await table.where('archiveId').equals(archiveId).delete()
}

async function materialize(
  archiveId: string,
  nodeId: string,
  branchId: string,
  database: YanJuDatabase,
  recovery?: RecoveryState,
  resume = false,
) {
  const current = await database.archives.get(archiveId)
  const saved = await database.nodes.get(nodeId)
  const node = saved && recovery ? { ...saved, ...recovery } : saved
  const context = node && (await database.contexts.get(node.contextId))
  if (!current || !node || node.archiveId !== archiveId || !context)
    throw new Error('找不到对应的剧情存档。')
  const revision = current.revision + 1
  const archive: Archive = {
    ...node.archive,
    id: archiveId,
    name: current.name,
    revision,
    updatedAt: Date.now(),
    navigationEpoch: (current.navigationEpoch ?? 0) + 1,
    content: context.content,
    persona: context.persona,
    summary: node.archive.summary && { ...node.archive.summary, revision },
    compactionError: undefined,
  }
  const messages = (await database.messageVersions.bulkGet(node.messageIds)).map((v) => {
    if (!v) throw new Error('存档的消息版本缺失。')
    return {
      ...v.value,
      ...(v.value.status === 'partial'
        ? { status: 'cancelled' as const, error: '此回合已中断，可重试。' }
        : {}),
    }
  })
  const tasks = (await database.taskVersions.bulkGet(node.taskIds)).map((v) => {
    if (!v) throw new Error('存档的任务版本缺失。')
    return {
      ...v.value,
      revision: v.value.revision === node.archive.revision ? revision : 0,
      ...(v.value.status === 'partial'
        ? { status: 'cancelled' as const, error: '此任务已中断，可重试。' }
        : {}),
    }
  })
  const projection = rebuildStory(archive, messages)
  await database.messages.where('archiveId').equals(archiveId).delete()
  await database.tasks.where('archiveId').equals(archiveId).delete()
  await database.storyEvents.where('archiveId').equals(archiveId).delete()
  await database.messages.bulkPut(messages)
  await database.tasks.bulkPut(tasks)
  await database.archives.put(archive)
  const savedState = await database.stateVersions.get(node.stateId)
  if (!savedState) throw new Error('存档的状态快照缺失。')
  await database.storyStates.put({ ...savedState.state, archiveId, revision })
  await database.storyEvents.bulkPut(projection.events)
  await database.sessions.update(archiveId, { nodeId, branchId, detached: !resume })
}

export async function navigateGame(
  archiveId: string,
  nodeId: string,
  branchId?: string,
  database = db,
  recovery?: RecoveryState,
  resume = false,
) {
  await stopGameOperations(archiveId)
  await withArchiveOperation(
    archiveId,
    () =>
      database.transaction(
        'rw',
        [
          ...database.gameTables,
          database.archives,
          database.messages,
          database.tasks,
          database.storyStates,
          database.storyEvents,
        ],
        async () => {
          const archive = await database.archives.get(archiveId)
          if (!archive) throw new Error('篇章已删除。')
          await captureRecovery(archiveId, database)
          const session = await database.sessions.get(archiveId)
          const target = await database.nodes.get(nodeId)
          if (!session || !target || target.archiveId !== archiveId)
            throw new Error('剧情节点不存在。')
          let branch = await database.branches.get(branchId ?? target.branchId)
          if (!branch || branch.archiveId !== archiveId) {
            branch = {
              id: crypto.randomUUID(),
              archiveId,
              headId: nodeId,
              forkNodeId: nodeId,
              name: '恢复的路线',
              createdAt: Date.now(),
            }
            await database.branches.add(branch)
          }
          await materialize(archiveId, nodeId, branch.id, database, recovery, resume)
        },
      ),
    database,
  )
  await database.persistence.flush()
}
export async function loadGameSave(archiveId: string, slotId: string, database = db) {
  const slot = await database.slots.get(slotId)
  if (!slot || slot.archiveId !== archiveId) throw new Error('存档位不存在。')
  await navigateGame(archiveId, slot.nodeId, slot.branchId, database, slot.recovery)
}
export async function loadGameBranch(archiveId: string, branchId: string, database = db) {
  const branch = await database.branches.get(branchId)
  if (!branch || branch.archiveId !== archiveId) throw new Error('路线不存在。')
  await navigateGame(
    archiveId,
    branch.headId,
    branch.id,
    database,
    branch.recovery?.nodeId === branch.headId ? branch.recovery : undefined,
    true,
  )
}
export async function forkGame(archiveId: string, nodeId?: string, name?: string, database = db) {
  await stopGameOperations(archiveId)
  return withArchiveOperation(
    archiveId,
    () =>
      database.transaction(
        'rw',
        [
          ...database.gameTables,
          database.archives,
          database.messages,
          database.tasks,
          database.storyStates,
          database.storyEvents,
        ],
        async () => {
          const archive = await database.archives.get(archiveId)
          if (!archive) throw new Error('篇章已删除。')
          const recovery = await captureRecovery(archiveId, database)
          const session = (await database.sessions.get(archiveId))!
          const target = nodeId ?? session.nodeId
          const count = await database.branches.where('archiveId').equals(archiveId).count()
          const branch: Branch = {
            id: crypto.randomUUID(),
            archiveId,
            name: name?.trim() || `路线 ${count + 1}`,
            headId: target,
            forkNodeId: target,
            createdAt: Date.now(),
          }
          await database.branches.add(branch)
          await materialize(
            archiveId,
            target,
            branch.id,
            database,
            nodeId ? undefined : recovery,
            true,
          )
          return branch
        },
      ),
    database,
  )
}
export async function saveGame(
  archiveId: string,
  name: string,
  kind: 'manual' | 'quick' = 'manual',
  overwriteId?: string,
  database = db,
) {
  return withSnapshotOperation(
    () =>
      database.transaction('rw', [...database.gameTables, database.operations], async () => {
        const importing = await database.operations.get('')
        if (importing && importing.expiresAt > Date.now()) throw new Error('导入期间请稍后保存。')
        if (!name.trim()) throw new Error('请输入存档名称。')
        const archive = await database.archives.get(archiveId)
        if (!archive) throw new Error('篇章已删除。')
        const recovery = await captureRecovery(archiveId, database)
        const nodeId = recovery.nodeId
        const session = (await database.sessions.get(archiveId))!
        const old = overwriteId
          ? await database.slots.get(overwriteId)
          : kind === 'quick'
            ? await database.slots
                .where('archiveId')
                .equals(archiveId)
                .filter((v) => v.kind === 'quick')
                .first()
            : undefined
        if (overwriteId && (!old || old.archiveId !== archiveId || old.kind !== 'manual'))
          throw new Error('存档位不存在。')
        const slot: SaveSlot = {
          id: old?.id ?? crypto.randomUUID(),
          archiveId,
          nodeId,
          recovery,
          branchId: session.branchId,
          name: name.trim(),
          kind,
          createdAt: Date.now(),
        }
        await database.slots.put(slot)
        return slot
      }),
    database,
  )
}
export async function messageSnapshot(archiveId: string, messageId: string, database = db) {
  const session = await database.sessions.get(archiveId)
  let node = session && (await database.nodes.get(session.nodeId))
  let source: HistoryNode | undefined
  while (node) {
    const records = await database.messageVersions.bulkGet(node.messageIds)
    if (records.some((v) => v?.value.id === messageId)) source = node
    else if (source) break
    node = node.parentId ? await database.nodes.get(node.parentId) : undefined
  }
  if (!source && session) {
    const recovery = (await database.branches.get(session.branchId))?.recovery
    if (recovery) {
      const records = await database.messageVersions.bulkGet(recovery.messageIds)
      if (records.some((v) => v?.value.id === messageId))
        source = { ...(await database.nodes.get(recovery.nodeId))!, ...recovery }
    }
  }
  if (!source) throw new Error('请选择已完成的剧情节点。')
  const context = (await database.contexts.get(source.contextId))!
  const messages = (await database.messageVersions.bulkGet(source.messageIds)).map((v) => v!.value)
  const end = messages.findIndex((m) => m.id === messageId)
  const prefix = messages.slice(0, end + 1)
  const summary = source.archive.summary
  const archive: Archive = {
    ...source.archive,
    content: context.content,
    persona: context.persona,
    draft: '',
    summary: summary && prefix.some((m) => m.id === summary.coveredThroughId) ? summary : undefined,
  }
  return { source, archive, messages: prefix }
}
export async function nodeForMessage(archiveId: string, messageId: string, database = db) {
  return database.transaction('rw', database.gameTables, async () => {
    const session = await database.sessions.get(archiveId)
    let node = session && (await database.nodes.get(session.nodeId))
    let completed: HistoryNode | undefined
    while (node) {
      const last = node.messageIds.at(-1)
      if (last && (await database.messageVersions.get(last))?.value.id === messageId)
        completed = node
      else if (completed) break
      node = node.parentId ? await database.nodes.get(node.parentId) : undefined
    }
    if (completed) return completed
    // Imported material can contain several completed turns in a single snapshot.
    const { source, archive, messages } = await messageSnapshot(archiveId, messageId, database)
    if (messages.at(-1)?.role !== 'assistant' || messages.at(-1)?.status !== 'complete')
      throw new Error('请选择已完成的剧情节点。')
    const snapshot = { ...archive }
    delete snapshot.content
    delete snapshot.persona
    const point: HistoryNode = {
      ...source,
      id: crypto.randomUUID(),
      parentId: source.parentId,
      messageIds: source.messageIds.slice(0, messages.length),
      taskIds: [],
      stateId: await captureState(database, archive, messages),
      archive: snapshot,
      label: '历史剧情',
      createdAt: messages.at(-1)!.createdAt,
    }
    // The new prefix belongs before this imported snapshot, so the selected route remains intact.
    await database.nodes.add(point)
    return point
  })
}
export async function prepareHistoryEdit(archive: Archive, messageId: string, database = db) {
  await captureRecovery(archive.id, database)
  const session = (await database.sessions.get(archive.id))!
  const { source } = await messageSnapshot(archive.id, messageId, database)
  const parentId = source.parentId ?? session.startNodeId
  await database.sessions.update(archive.id, { nodeId: parentId })
  const count = await database.branches.where('archiveId').equals(archive.id).count()
  const branch: Branch = {
    id: crypto.randomUUID(),
    archiveId: archive.id,
    headId: parentId,
    forkNodeId: parentId,
    name: `路线 ${count + 1}`,
    createdAt: Date.now(),
  }
  await database.branches.add(branch)
  await database.sessions.update(archive.id, { branchId: branch.id })
  await materialize(
    archive.id,
    source.id,
    branch.id,
    database,
    {
      nodeId: source.id,
      archive: source.archive,
      contextId: source.contextId,
      stateId: source.stateId,
      messageIds: source.messageIds,
      taskIds: source.taskIds,
    },
    true,
  )
  await database.sessions.update(archive.id, { nodeId: parentId })
  return (await database.archives.get(archive.id))!
}
export async function updateGameContext(
  archiveId: string,
  content: StoryContent,
  persona?: Persona,
  database = db,
) {
  await stopGameOperations(archiveId)
  await withArchiveOperation(
    archiveId,
    () =>
      database.transaction('rw', database.gameTables, async () => {
        const archive = await database.archives.get(archiveId)
        if (!archive) throw new Error('篇章已删除。')
        const next = {
          ...archive,
          content,
          persona,
          userName: persona?.name ?? archive.userName,
          revision: archive.revision + 1,
          summary: undefined,
          updatedAt: Date.now(),
        }
        const projection = rebuildStory(
          next,
          await database.messages.where('archiveId').equals(archiveId).sortBy('sequence'),
        )
        await database.archives.put(next)
        await database.storyStates.put(projection.story)
        await database.storyEvents.where('archiveId').equals(archiveId).delete()
        await database.storyEvents.bulkPut(projection.events)
        await captureGameNode(database, next, '设定与人设', true)
      }),
    database,
  )
}

export async function collectGameHistory(archiveId: string, database = db) {
  const nodes = await database.nodes.where('archiveId').equals(archiveId).toArray()
  const branches = await database.branches.where('archiveId').equals(archiveId).toArray()
  const slots = await database.slots.where('archiveId').equals(archiveId).toArray()
  const session = await database.sessions.get(archiveId)
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const recoveries = [...branches, ...slots].flatMap((v) => (v.recovery ? [v.recovery] : []))
  const keep = new Set<string>()
  for (const root of [
    ...branches.map((b) => b.headId),
    ...slots.map((s) => s.nodeId),
    ...recoveries.map((r) => r.nodeId),
    ...(session ? [session.nodeId, session.startNodeId] : []),
  ]) {
    let node = byId.get(root)
    while (node && !keep.has(node.id)) {
      keep.add(node.id)
      node = node.parentId ? byId.get(node.parentId) : undefined
    }
  }
  await database.nodes.bulkDelete(nodes.filter((n) => !keep.has(n.id)).map((n) => n.id))
  const retained = nodes.filter((n) => keep.has(n.id))
  for (const [table, refs] of [
    [database.stateVersions, new Set([...retained, ...recoveries].map((n) => n.stateId))],
    [database.contexts, new Set([...retained, ...recoveries].map((n) => n.contextId))],
    [database.messageVersions, new Set([...retained, ...recoveries].flatMap((n) => n.messageIds))],
    [database.taskVersions, new Set([...retained, ...recoveries].flatMap((n) => n.taskIds))],
  ] as const) {
    const records = await table.where('archiveId').equals(archiveId).toArray()
    await table.bulkDelete(records.filter((v) => !refs.has(v.id)).map((v) => v.id))
  }
}
export async function deleteGameBranch(archiveId: string, branchId: string) {
  await withArchiveOperation(archiveId, () =>
    db.transaction('rw', db.gameTables, async () => {
      const session = await db.sessions.get(archiveId)
      const branch = await db.branches.get(branchId)
      if (!branch || branch.archiveId !== archiveId || session?.branchId === branchId)
        throw new Error('请先切换到另一条路线。')
      await db.branches.delete(branchId)
      await db.slots.where('[branchId+kind]').equals([branchId, 'auto']).delete()
      await collectGameHistory(archiveId)
    }),
  )
}
export async function deleteGameSlot(archiveId: string, slotId: string) {
  await withArchiveOperation(archiveId, () =>
    db.transaction('rw', db.gameTables, async () => {
      if ((await db.slots.get(slotId))?.archiveId !== archiveId) throw new Error('存档位不存在。')
      await db.slots.delete(slotId)
      await collectGameHistory(archiveId)
    }),
  )
}
