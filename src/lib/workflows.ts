import { db, archiveMessages, refreshStory, revise } from './db'
import { channelIsReady, friendlyError, summarize } from './provider'
import { runStructuredTask } from './task-runner'
import {
  taskDefinitions,
  taskInputSchema,
  validateTask,
  type AuxiliaryKind,
  type TaskOutput,
  type TaskInput,
} from './tasks'
import { ContentValidationError, validateNarrative } from './schemas'
import {
  applyMessage,
  initialStory,
  rebuildStory,
  storyContext,
  entityName,
  type StoryState,
} from './story'
import { validDate } from './domain-schema'
import type { Archive, StoredMessage, TaskRun } from './types'
import { tracks } from './media'
import { z } from 'zod'
import { calibrate, compactContext, estimateTokens, serializeRequest } from './context'
import { commitSummary } from './db'
import { taskInstructions } from './task-runner'
import { taskSchemas } from './tasks'

const invalid = (text: string): never => {
  throw new ContentValidationError([text])
}
async function saveTaskProgress(task: TaskRun, create = false) {
  return db.transaction('rw', [db.archives, db.tasks], async () => {
    const archive = await db.archives.get(task.archiveId)
    if (!archive || (create ? archive.revision !== task.revision : !(await db.tasks.get(task.id))))
      return false
    await db.tasks.put(task)
    return true
  })
}
export function messageText(message: StoredMessage) {
  if (message.reply?.kind === 'narrative')
    return message.reply.value.blocks.map((b) => `${b.text}\n${b.translation}`).join('\n\n')
  if (message.reply?.kind === 'forum')
    return [
      message.reply.value.post.content,
      ...message.reply.value.answers.map((a) => a.content),
    ].join('\n\n')
  return message.content
}
function validateChapters(value: TaskOutput<'chapters'>, history: StoredMessage[]) {
  const seen = new Set<string>()
  let previous = -1
  for (const chapter of value.chapters) {
    if (!chapter.messageIds.length) invalid('章节至少引用一条消息')
    for (const id of chapter.messageIds) {
      const message = history.find((m) => m.id === id)
      if (!message || seen.has(id)) invalid('章节引用未知或重复消息')
      if (message!.sequence < previous) invalid('章节须按原始消息顺序整理')
      previous = message!.sequence
      seen.add(id)
    }
  }
  if (seen.size !== history.length) invalid('章节须覆盖全部有效消息，不能遗漏原文')
}
function validateAuxiliary<K extends AuxiliaryKind>(
  kind: K,
  value: TaskOutput<K>,
  input: TaskInput,
  story: StoryState,
  history: StoredMessage[],
) {
  const hasEntity = (id: string) => story.entities.some((e) => e.id === id)
  if (kind === 'phoneReply') {
    const v = value as TaskOutput<'phoneReply'>
    if (v.contactRef !== input.targetId || !story.phones.some((p) => p.id === v.contactRef))
      invalid('手机回复联系人不匹配')
  }
  if (kind === 'forumReply') {
    const v = value as TaskOutput<'forumReply'>
    const forum = story.forums.find((f) => f.id === v.postId)
    if (
      !forum ||
      v.replyTo !== input.targetId ||
      (v.replyTo !== forum.id && !forum.answers.some((a) => a.id === v.replyTo))
    )
      invalid('论坛回复目标不存在或不匹配')
  }
  if (kind === 'search') {
    const v = value as TaskOutput<'search'>
    if (v.entityRefs.some((ref) => !hasEntity(ref))) invalid('搜索引用未知实体')
    if (
      (v.fromDate && !validDate(v.fromDate)) ||
      (v.toDate && !validDate(v.toDate)) ||
      (v.fromDate && v.toDate && v.fromDate > v.toDate)
    )
      invalid('搜索日期范围无效')
  }
  if (kind === 'rewrite') {
    const v = value as TaskOutput<'rewrite'>
    const target = history.find((m) => m.id === input.targetId)
    if (target?.reply?.kind !== 'narrative') invalid('改写目标不是有效叙事')
    const old = target!.reply!.kind === 'narrative' ? target!.reply!.value.blocks : []
    const ids = new Set(old.map((b) => b.id))
    if (
      v.replacement.blocks.length !== old.length ||
      v.replacement.blocks.some((b) => !ids.has(b.id)) ||
      v.changedBlockIds.some((id) => !ids.has(id)) ||
      new Set(v.changedBlockIds).size !== v.changedBlockIds.length
    )
      invalid('改写须保留原段落 ID 与数量')
    const changed = old
      .filter((block) => {
        const next = v.replacement.blocks.find((next) => next.id === block.id)!
        return (
          block.text !== next.text ||
          block.translation !== next.translation ||
          block.kind !== next.kind ||
          block.speakerRef !== next.speakerRef
        )
      })
      .map((block) => block.id)
    if (
      changed.some((id) => !v.changedBlockIds.includes(id)) ||
      v.changedBlockIds.some((id) => !changed.includes(id))
    )
      invalid('改写段落清单与实际修改不匹配')
    if (JSON.stringify(validateNarrative(target!.reply!.value)) === JSON.stringify(v.replacement))
      invalid('改写没有修改任何内容，请按要求修改正文或相关模块')
    const prefix = history.filter((m) => m.sequence < target!.sequence)
    applyMessage(
      rebuildStory({ id: story.archiveId, revision: story.revision } as Archive, prefix).story,
      { ...target!, reply: { kind: 'narrative', value: v.replacement } },
    )
  }
  if (kind === 'consistency') {
    for (const issue of (value as TaskOutput<'consistency'>).issues) {
      const m = history.find((m) => m.id === issue.source.messageId)
      if (
        !m ||
        (issue.source.blockId !== null &&
          (m.reply?.kind !== 'narrative' ||
            !m.reply.value.blocks.some((b) => b.id === issue.source.blockId)))
      )
        invalid('检查引用的消息或段落不存在')
      if (!messageText(m!).includes(issue.evidence)) invalid('检查证据没有出现在引用的原文中')
      if (issue.source.blockId !== null && m!.reply?.kind === 'narrative') {
        const block = m!.reply.value.blocks.find((b) => b.id === issue.source.blockId)!
        if (!`${block.text}\n${block.translation}`.includes(issue.evidence))
          invalid('检查证据与引用段落不匹配')
      }
    }
  }
  if (kind === 'chapters') {
    validateChapters(value as TaskOutput<'chapters'>, history)
  }
  if (kind === 'media') {
    const v = value as TaskOutput<'media'>
    if (v.trackId !== null && !tracks.some((t) => t.id === v.trackId)) invalid('配乐曲目不存在')
    const target = history.find((m) => m.id === input.targetId)
    if (target?.reply?.kind !== 'narrative') invalid('媒体描述对应的叙事已失效，请重新生成。')
    if (
      v.voice.some(
        (item) =>
          target?.reply?.kind !== 'narrative' ||
          !target.reply.value.blocks.some((b) => b.id === item.blockId),
      )
    )
      invalid('语音描述引用未知段落')
  }
  if (kind === 'command') {
    const v = value as TaskOutput<'command'>
    if (v.action === 'mode' && v.mode === null) invalid('切换模式缺少目标模式')
    if (v.action === 'search' && !v.query) invalid('搜索操作缺少查询')
    if (v.targetId !== null) {
      const archives = input.context.archives as { id: string }[]
      if (
        (v.action === 'music' && !tracks.some((t) => t.id === v.targetId)) ||
        (v.action === 'archive' && !archives.some((a) => a.id === v.targetId)) ||
        (v.action === 'character' &&
          !story.entities.some((e) => e.id === v.targetId && e.kind === 'character')) ||
        (v.action === 'phone' && !story.phones.some((p) => p.id === v.targetId))
      )
        invalid('操作目标不存在')
    }
  }
  if (kind === 'contentImport') {
    const output = value as TaskOutput<'contentImport'>
    for (const key of [
      'entities',
      'states',
      'relationships',
      'knowledge',
      'events',
      'memories',
      'goals',
    ] as const)
      if (output.effects[key].some((item) => item.sourceBlockId !== null))
        invalid('导入资料的来源须指向完整材料，sourceBlockId 应为 null')
    applyMessage(structuredClone(story), {
      id: 'preview-import',
      archiveId: story.archiveId,
      sequence: 0,
      createdAt: 0,
      role: 'assistant',
      kind: 'material',
      status: 'complete',
      content: input.text,
      effects: output.effects,
    })
  }
}

export async function executeAuxiliary<K extends AuxiliaryKind>(
  archiveId: string,
  kind: K,
  text: string,
  targetId: string | null,
  options: {
    signal?: AbortSignal
    onPartial?: (task: TaskRun) => void
    fetcher?: typeof fetch
  } = {},
): Promise<TaskRun> {
  if (kind === 'contentImport') {
    let material: unknown
    try {
      material = JSON.parse(text)
    } catch {
      /* Plain text is also supported. */
    }
    if (
      material &&
      typeof material === 'object' &&
      'version' in material &&
      ('archives' in material || 'messages' in material)
    )
      throw new Error('应用存档请通过存档管理导入；资料提取不处理应用存档。')
  }
  const archive = await db.archives.get(archiveId)
  const settings = await db.settings.get('app')
  const channel = settings?.activeChannelId
    ? await db.channels.get(settings.activeChannelId)
    : undefined
  if (!archive || !channel || !channelIsReady(channel))
    throw new Error('请先选择篇章并配置已测试的渠道。')
  const persona = settings?.activePersonaId
    ? await db.personas.get(settings.activePersonaId)
    : undefined
  const history = (await archiveMessages(archiveId)).filter(
    (m) => !m.stale && m.status === 'complete',
  )
  const story = rebuildStory(archive, history).story
  const target = history.find((m) => m.id === targetId)
  const input: TaskInput = {
    text,
    targetId,
    context: {
      archive: { id: archive.id, name: archive.name, summary: archive.summary?.value },
      persona: persona ?? null,
      story: storyContext(story),
      target: target?.reply?.value ?? null,
      phone: story.phones.find((p) => p.id === targetId) ?? null,
      forum:
        story.forums.find((f) => f.id === targetId || f.answers.some((a) => a.id === targetId)) ??
        null,
      archives: (await db.archives.toArray()).map((a) => ({ id: a.id, name: a.name })),
      tracks: tracks.map(({ id, name }) => ({ id, name })),
      history: (kind === 'chapters' ? history : history.slice(-8)).map((m) => ({
        id: m.id,
        role: m.role,
        text: kind === 'chapters' ? messageText(m).slice(0, 480) : messageText(m),
        blocks:
          m.reply?.kind === 'narrative'
            ? m.reply.value.blocks.map((b) => ({ id: b.id, text: b.text.slice(0, 480) }))
            : [],
      })),
    },
  }
  taskInputSchema.parse(input)
  const task: TaskRun = {
    id: crypto.randomUUID(),
    archiveId,
    revision: archive.revision,
    kind,
    input,
    channelId: channel.id,
    createdAt: Date.now(),
    status: 'partial',
  }
  if (!(await saveTaskProgress(task, true))) throw new Error('篇章已变更，请重新生成后保存。')
  let checkpoint = Promise.resolve()
  let checkpointAt = 0
  try {
    const estimate = () =>
      estimateTokens(
        serializeRequest(
          channel,
          taskInstructions(kind),
          [{ role: 'user', content: JSON.stringify(input) }],
          z.toJSONSchema(taskSchemas[kind]),
          taskDefinitions[kind].name,
        ),
        channel.calibration?.ratio,
      )
    if (estimate() + channel.maxOutputTokens > channel.contextWindow && history.length > 2) {
      const summary = await compactContext({
        archive,
        channel,
        persona,
        kind: 'narrative',
        messages: history,
        signal: options.signal ?? new AbortController().signal,
        force: true,
        summarize: (value, signal) =>
          summarize(channel, value, signal, options.fetcher, archive.id),
        commit: (value) => commitSummary(archive.id, archive.revision, value),
      })
      if (summary) {
        input.context.archive = { id: archive.id, name: archive.name, summary: summary.value }
        const covered = history.findIndex((m) => m.id === summary.coveredThroughId)
        if (kind !== 'chapters' && kind !== 'consistency')
          input.context.history = input.context.history.filter(
            (m) => history.findIndex((source) => source.id === m.id) > covered,
          )
        await db.tasks.update(task.id, { input })
      }
    }
    const result = await runStructuredTask({
      archiveId,
      ownerId: task.id,
      kind,
      channel,
      input,
      signal: options.signal,
      fetcher: options.fetcher,
      validate: (value) => validateAuxiliary(kind, value, input, story, history),
      onPartial: (partial, raw) => {
        task.partial = partial
        task.raw = raw
        options.onPartial?.({ ...task })
        if (Date.now() - checkpointAt > 500) {
          checkpointAt = Date.now()
          const snapshot = structuredClone(task)
          checkpoint = checkpoint.then(() => saveTaskProgress(snapshot)).then(() => undefined)
        }
      },
      onCorrection: (_detail, correction) => {
        task.correction = correction
      },
    })
    await checkpoint
    if (options.signal?.aborted) throw new DOMException('已取消', 'AbortError')
    Object.assign(task, {
      output: result.value,
      usage: result.usage,
      correction: result.correction,
      status: 'complete',
    })
    if (!(await saveTaskProgress(task)))
      throw new Error('篇章已删除或资料已替换，收到的结果保留在请求记录中。')
    const calibration = calibrate(
      channel,
      result.usage?.input,
      result.usage?.estimatedInput ?? estimate(),
    )
    if (calibration) await db.channels.update(channel.id, { calibration })
    if (options.signal?.aborted) throw new DOMException('已取消', 'AbortError')
    if (kind === 'phoneReply' || kind === 'forumReply') await applyTask(task.id)
    await db.persistence.flush()
    return (await db.tasks.get(task.id))!
  } catch (error) {
    await checkpoint.catch(() => undefined)
    task.status = options.signal?.aborted ? 'cancelled' : 'failed'
    task.error = friendlyError(error)
    await saveTaskProgress(task)
    await db.persistence.flush()
    return task
  }
}

export async function applyTask(id: string, editedOutput?: unknown) {
  await db.transaction(
    'rw',
    [db.archives, db.messages, db.storyStates, db.storyEvents, db.tasks, db.personas, db.settings],
    async () => {
      const task = await db.tasks.get(id)
      if (!task || task.status !== 'complete') throw new Error('任务尚未完成，不能应用。')
      if (task.applied) return
      const archive = await db.archives.get(task.archiveId)
      if (!archive || archive.revision !== task.revision)
        throw new Error('篇章已变更，请重新生成后应用。')
      const value = validateTask(task.kind, editedOutput ?? task.output)
      const all = await archiveMessages(archive.id)
      const story = rebuildStory(archive, all).story
      const validationInput =
        task.kind === 'command'
          ? {
              ...task.input,
              context: {
                ...task.input.context,
                archives: (await db.archives.toArray()).map((a) => ({ id: a.id, name: a.name })),
              },
            }
          : task.input
      validateAuxiliary(
        task.kind,
        value,
        validationInput,
        story,
        all.filter((m) => !m.stale && m.status === 'complete'),
      )
      if (task.kind === 'persona') {
        const persona = value as TaskOutput<'persona'>
        await db.personas.put({ ...persona, id: crypto.randomUUID(), createdAt: Date.now() })
        await db.tasks.update(id, { output: value, applied: true })
        return
      }
      if (task.kind === 'continuation') throw new Error('请选择一个分支，推进成功后才会保存选择。')
      const base: StoredMessage = {
        id: `task:${task.id}`,
        archiveId: archive.id,
        role: 'assistant',
        sequence: (all.at(-1)?.sequence ?? -1) + 1,
        createdAt: Date.now(),
        kind: 'material',
        status: 'complete',
        content: task.input.text,
        userName: task.input.context.persona?.name ?? archive.userName,
        usage: task.usage,
      }
      const updated = revise(archive)
      if (task.kind === 'phoneReply') {
        const v = value as TaskOutput<'phoneReply'>
        const speaker = entityName(story, v.contactRef)
        await db.messages.put({
          ...base,
          kind: 'interaction',
          content: `${base.userName ?? '你'}：${task.input.text}\n${speaker}：${v.text}`,
          interaction: { kind: 'phone', ...v, speaker, userText: task.input.text },
        })
      } else if (task.kind === 'forumReply') {
        const v = value as TaskOutput<'forumReply'>
        await db.messages.put({
          ...base,
          kind: 'interaction',
          content: `${base.userName ?? '你'}：${task.input.text}\n${v.author}：${v.content}`,
          interaction: { kind: 'forum', ...v, userText: task.input.text },
        })
      } else if (task.kind === 'contentImport') {
        const v = value as TaskOutput<'contentImport'>
        await db.messages.put({
          ...base,
          content: `资料：${v.title}\n${v.summary}\n原始材料：\n${task.input.text}`,
          effects: v.effects,
        })
      } else if (task.kind === 'rewrite') {
        const target = all.find((m) => m.id === task.input.targetId)
        if (!target || target.reply?.kind !== 'narrative') throw new Error('找不到改写目标')
        const replacement = validateNarrative((value as TaskOutput<'rewrite'>).replacement)
        applyMessage(
          rebuildStory(
            archive,
            all.filter((m) => m.sequence < target.sequence),
          ).story,
          { ...target, reply: { kind: 'narrative', value: replacement } },
        )
        await db.messages.put({
          ...target,
          reply: { kind: 'narrative', value: replacement },
          content: JSON.stringify(replacement),
          correction: undefined,
        })
        await db.messages.bulkPut(
          all.filter((m) => m.sequence > target.sequence).map((m) => ({ ...m, stale: true })),
        )
        updated.summary = undefined
      } else if (task.kind === 'archiveMetadata') {
        const metadata = value as TaskOutput<'archiveMetadata'>
        updated.name = metadata.name
        updated.description = metadata.summary
        updated.keywords = metadata.keywords
      } else if (
        taskDefinitions[task.kind].commit === 'query' ||
        task.kind === 'media' ||
        task.kind === 'chapters'
      ) {
        await db.tasks.update(id, { output: value, applied: true })
        return
      }
      await db.archives.put(updated)
      await refreshStory(db, updated)
      await db.tasks.update(id, { output: value, applied: true })
    },
  )
  await db.persistence.flush()
}

export async function chooseContinuation(
  id: string,
  action: string,
  send: (text: string, expectedRevision: number) => Promise<boolean>,
) {
  const task = await db.transaction('r', [db.archives, db.tasks], async () => {
    const task = await db.tasks.get(id)
    if (!task || task.kind !== 'continuation' || task.status !== 'complete')
      throw new Error('分支任务尚未完成。')
    if (task.applied) return undefined
    const archive = await db.archives.get(task.archiveId)
    if (!archive || archive.revision !== task.revision)
      throw new Error('篇章已变更，请重新生成后选择分支。')
    const value = validateTask('continuation', task.output)
    if (!value.options.some((option) => option.action === action))
      throw new Error('分支选项不存在。')
    return task
  })
  if (!task || !(await send(action, task.revision))) return false
  await db.transaction('rw', [db.archives, db.tasks], async () => {
    const current = await db.tasks.get(id)
    if (
      !(await db.archives.get(task.archiveId)) ||
      !current ||
      current.status !== 'complete' ||
      current.archiveId !== task.archiveId ||
      JSON.stringify(current.output) !== JSON.stringify(task.output)
    )
      throw new Error('分支任务已变更，推进的剧情仍已保存。')
    await db.tasks.update(id, { applied: true })
  })
  await db.persistence.flush()
  return true
}

export async function saveMediaDraft(id: string, editedOutput: unknown) {
  await db.transaction('rw', [db.archives, db.messages, db.tasks], async () => {
    const task = await db.tasks.get(id)
    if (!task || task.kind !== 'media' || task.status !== 'complete')
      throw new Error('媒体任务尚未完成，不能保存。')
    const archive = await db.archives.get(task.archiveId)
    if (!archive) throw new Error('篇章已删除。')
    const value = validateTask('media', editedOutput)
    const history = (await archiveMessages(archive.id)).filter(
      (m) => m.status === 'complete' && !m.stale,
    )
    validateAuxiliary('media', value, task.input, initialStory(archive.id), history)
    await db.tasks.update(id, { output: value })
  })
  await db.persistence.flush()
}

export interface SearchHit {
  id: string
  category: string
  title: string
  text: string
  date: string | null
  entities: string[]
  source: { messageId: string; blockId: string | null }
}
export function searchStory(
  story: StoryState,
  history: StoredMessage[],
  query: TaskOutput<'search'>,
): SearchHit[] {
  const validHistory = history
    .filter((m) => m.status === 'complete' && !m.stale)
    .sort((a, b) => a.sequence - b.sequence)
  const dates = new Map<string, string | null>()
  let currentDate: string | null = null
  for (const message of validHistory) {
    const effects =
      message.reply?.kind === 'narrative' ? message.reply.value.effects : message.effects
    currentDate = effects?.clock.dateTime?.slice(0, 10) ?? currentDate
    dates.set(message.id, currentDate)
  }
  const references = (message: StoredMessage) => {
    const refs =
      message.reply?.kind === 'narrative'
        ? [...message.reply.value.scene.characterRefs, message.reply.value.scene.locationRef]
        : message.interaction?.kind === 'phone'
          ? [message.interaction.contactRef]
          : []
    return refs
      .filter((ref): ref is string => ref !== null)
      .map((ref) => (ref.startsWith('new:') ? `${message.id}:entity:${ref.slice(4)}` : ref))
  }
  const rows: SearchHit[] = [
    ...story.events.map((e) => ({
      id: e.id,
      category: 'event',
      title: e.title,
      text: `${e.description} ${e.locationRef ? entityName(story, e.locationRef) : ''}`,
      date: e.time?.slice(0, 10) ?? null,
      entities: [...e.participants, ...(e.locationRef ? [e.locationRef] : [])],
      source: e.source,
    })),
    ...story.memories
      .filter((m) => m.status === 'active')
      .map((m) => ({
        id: m.id,
        category: 'memory',
        title: m.kind === 'preference' ? '偏好' : '事实',
        text: m.content,
        date: dates.get(m.source.messageId) ?? null,
        entities: m.entityRefs,
        source: m.source,
      })),
    ...story.goals.map((g) => ({
      id: g.id,
      category: 'goal',
      title: g.status,
      text: g.description,
      date: g.dueDate,
      entities: [g.ownerRef],
      source: g.source,
    })),
    ...story.diaries.map((d) => ({
      id: d.id,
      category: 'diary',
      title: '日记',
      text: d.text,
      date: d.date,
      entities: [],
      source: d.source,
    })),
    ...validHistory.map((m) => ({
      id: m.id,
      category: 'message',
      title: m.role === 'user' ? '你的消息' : '宴雎的回复',
      text: messageText(m),
      date: dates.get(m.id) ?? null,
      entities: references(m),
      source: { messageId: m.id, blockId: null },
    })),
  ]
  return rows.filter(
    (r) =>
      (query.category === 'all' || r.category === query.category) &&
      (!query.entityRefs.length || query.entityRefs.some((id) => r.entities.includes(id))) &&
      query.terms.every((term) =>
        `${r.title} ${r.text}`.toLocaleLowerCase().includes(term.toLocaleLowerCase()),
      ) &&
      (!query.fromDate || (r.date !== null && r.date >= query.fromDate)) &&
      (!query.toDate || (r.date !== null && r.date <= query.toDate)),
  )
}
export function storyMarkdown(
  archive: Archive,
  history: StoredMessage[],
  chapters?: TaskOutput<'chapters'>,
) {
  const valid = history.filter((m) => m.status === 'complete' && !m.stale)
  if (chapters) validateChapters(chapters, valid)
  const groups = chapters?.chapters ?? [
    { title: archive.name, summary: archive.description ?? '', messageIds: valid.map((m) => m.id) },
  ]
  return (
    `# ${chapters?.title ?? archive.name}\n\n` +
    groups
      .map(
        (group) =>
          `## ${group.title}\n\n${group.summary}\n\n` +
          group.messageIds
            .map((id) => {
              const m = valid.find((m) => m.id === id)
              return m ? `### ${m.role === 'user' ? '你' : '宴雎'}\n\n${messageText(m)}\n` : ''
            })
            .join('\n'),
      )
      .join('\n')
  )
}
export function currentStory(archiveId: string, story?: StoryState) {
  return story ?? initialStory(archiveId)
}
