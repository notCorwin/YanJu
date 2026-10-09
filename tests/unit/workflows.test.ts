import { catalogFingerprintFixture } from '../fixtures'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { channelFingerprint } from '../../src/lib/provider'
import {
  appendMessage,
  archiveMessages,
  db,
  editMessage,
  exportSave,
  importSave,
} from '../../src/lib/storage'
import { taskSchemas, validateTask, type AuxiliaryKind, type TaskInput } from '../../src/lib/tasks'
import { defaults, type StoredMessage } from '../../src/lib/types'
import {
  applyTask,
  chooseContinuation,
  executeAuxiliary,
  saveMediaDraft,
  storyMarkdown,
} from '../../src/lib/workflows'
import { auxiliaryFixture } from '../auxiliary-fixtures'
import {
  channelFixture,
  compressionFixture,
  forumFixture,
  messageFixture,
  narrativeFixture,
  responseSse,
  sse,
} from '../fixtures'

const archive = {
  id: 'archive-1',
  name: '阅读篇章',
  userName: '沈辞玉',
  createdAt: 0,
  updatedAt: 0,
  revision: 0,
  draft: '',
}
const messages: StoredMessage[] = [
  messageFixture('u', 'user', '开始阅读', 0),
  {
    ...messageFixture('n', 'assistant', '', 1),
    reply: { kind: 'narrative', value: narrativeFixture },
  },
  {
    ...messageFixture('f', 'assistant', '', 2),
    kind: 'forum',
    reply: { kind: 'forum', value: forumFixture },
  },
]
beforeEach(async () => {
  await importSave({
    version: 3,
    archives: [archive],
    messages,
    channels: [channelFixture],
    masks: [],
    settings: { ...defaults, activeChannelId: 'channel-1', activeArchiveId: 'archive-1' },
    storyStates: [],
    storyEvents: [],
    tasks: [],
    requests: [],
  })
  await db.channels.update('channel-1', {
    capability: {
      fingerprint: channelFingerprint(channelFixture),
      catalogFingerprint: catalogFingerprintFixture,
      ok: true,
      testedAt: 0,
      protocol: 'chat-completions',
      checks: { 'chat-completions': { nonStreaming: 'passed', streaming: 'passed' } },
    },
  })
})
function fake(
  kind: AuxiliaryKind,
  transform?: (output: unknown, input: TaskInput) => unknown,
  finish = 'stop',
) {
  return vi.fn<typeof fetch>(async (_url, options) => {
    const body = JSON.parse(String(options?.body))
    const responses = !!body.text
    if (responses) {
      expect(body.text.format.type).toBe('json_schema')
      expect(body.text.format.strict).toBe(true)
      expect(body.store).toBe(false)
    } else {
      expect(body.response_format.type).toBe('json_schema')
      expect(body.response_format.json_schema.strict).toBe(true)
    }
    const input = JSON.parse(
      responses
        ? body.input.find((m: { role: string }) => m.role === 'user').content[0].text
        : body.messages[1].content,
    ) as TaskInput
    const output = auxiliaryFixture(kind, input)
    const value = transform ? transform(output, input) : output
    return new Response((responses ? responseSse(value) : sse(value, finish)).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    })
  })
}
describe('辅助任务完整链路', () => {
  it('保存未启用的人设不改变篇章或投影，同轮其他任务仍可应用', async () => {
    const persona = await executeAuxiliary(archive.id, 'persona', '创建读者', null, {
      fetcher: fake('persona'),
    })
    const metadata = await executeAuxiliary(archive.id, 'archiveMetadata', '整理简介', null, {
      fetcher: fake('archiveMetadata'),
    })
    const before = await db.archives.get(archive.id)
    const projection = await db.storyStates.get(archive.id)
    const events = await db.storyEvents.toArray()
    await applyTask(persona.id)
    expect(await db.archives.get(archive.id)).toEqual(before)
    expect(await db.storyStates.get(archive.id)).toEqual(projection)
    expect(await db.storyEvents.toArray()).toEqual(events)
    expect((await db.tasks.get(persona.id))?.applied).toBe(true)
    await applyTask(metadata.id)
    expect((await db.archives.get(archive.id))?.name).toBe('书房里的午后')
  })
  it('章节遗漏有效原文时纠正一次并拒绝保存完整结果', async () => {
    const fetcher = fake('chapters', (output) => {
      const value = output as { chapters: { messageIds: string[] }[] }
      value.chapters[0].messageIds = ['n']
      return value
    })
    const task = await executeAuxiliary(archive.id, 'chapters', '整理全部剧情', null, { fetcher })
    expect(task.status).toBe('failed')
    expect(task.error).toContain('全部有效消息')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect((await db.tasks.get(task.id))?.output).toBeUndefined()
    expect(() =>
      storyMarkdown(archive, messages, {
        title: '不完整章节',
        chapters: [{ title: '第一章', summary: '只列出了一条', messageIds: ['n'] }],
      }),
    ).toThrow(/全部有效消息/)
  })
  it('无变化的改写在生成和应用时均被拒绝，不使后续剧情失效', async () => {
    await db.archives.update(archive.id, {
      summary: {
        value: compressionFixture,
        coveredThroughId: 'f',
        coveredCount: 3,
        revision: 0,
        createdAt: 0,
      },
    })
    const before = await exportSave()
    const noop = { replacement: structuredClone(narrativeFixture), changedBlockIds: [] }
    const fetcher = fake('rewrite', () => noop)
    const failed = await executeAuxiliary(archive.id, 'rewrite', '修改第一段', 'n', { fetcher })
    expect(failed.status).toBe('failed')
    expect(failed.error).toContain('没有修改')
    expect(fetcher).toHaveBeenCalledTimes(2)
    const valid = await executeAuxiliary(archive.id, 'rewrite', '修改第一段', 'n', {
      fetcher: fake('rewrite'),
    })
    await db.tasks.update(valid.id, { output: noop })
    await expect(applyTask(valid.id)).rejects.toThrow(/没有修改/)
    const after = await exportSave()
    expect(after.archives).toEqual(before.archives)
    expect(after.messages).toEqual(before.messages)
    expect(after.storyStates).toEqual(before.storyStates)
    expect(after.storyEvents).toEqual(before.storyEvents)
  })
  it('仅修改关联模块的改写仍可生成与应用', async () => {
    const task = await executeAuxiliary(archive.id, 'rewrite', '只调整角色状态', 'n', {
      fetcher: fake('rewrite', () => {
        const replacement = structuredClone(narrativeFixture)
        replacement.effects.states[0].value = '更加平静'
        return { replacement, changedBlockIds: [] }
      }),
    })
    expect(task.status, task.error).toBe('complete')
    await applyTask(task.id)
    expect((await db.storyStates.get(archive.id))!.states[0].value).toBe('更加平静')
  })
  it('分支发送失败保留未应用状态，之后仍可重新选择', async () => {
    const task = await executeAuxiliary(archive.id, 'continuation', '提供分支', null, {
      fetcher: fake('continuation'),
    })
    const action = validateTask('continuation', task.output).options[0].action
    const failed = vi.fn(async () => false)
    expect(await chooseContinuation(task.id, action, failed)).toBe(false)
    expect((await db.tasks.get(task.id))?.applied).not.toBe(true)
    expect(await db.archives.get(archive.id)).toEqual(archive)
    const success = vi.fn(async () => true)
    expect(await chooseContinuation(task.id, action, success)).toBe(true)
    expect((await db.tasks.get(task.id))?.applied).toBe(true)
    expect(await chooseContinuation(task.id, action, success)).toBe(false)
    expect(success).toHaveBeenCalledTimes(1)
  })
  it('分支在完整剧情提交前不标为已应用，并拒绝失效版本或未知选项', async () => {
    const task = await executeAuxiliary(archive.id, 'continuation', '提供分支', null, {
      fetcher: fake('continuation'),
    })
    const action = validateTask('continuation', task.output).options[0].action
    const send = vi.fn(async (text: string, revision: number) => {
      await appendMessage(messageFixture('branch-user', 'user', text, 3), revision)
      expect((await db.tasks.get(task.id))?.applied).not.toBe(true)
      await appendMessage(
        {
          ...messageFixture('branch-reply', 'assistant', '', 4),
          reply: { kind: 'narrative', value: narrativeFixture },
        },
        revision + 1,
      )
      return true
    })
    await expect(chooseContinuation(task.id, '不存在的行动', send)).rejects.toThrow(/不存在/)
    expect(send).not.toHaveBeenCalled()
    await expect(applyTask(task.id)).rejects.toThrow(/请选择一个分支/)
    expect(await chooseContinuation(task.id, action, send)).toBe(true)
    expect((await db.tasks.get(task.id))?.applied).toBe(true)
    const stale = { ...task, id: 'stale-branch', applied: false }
    await db.tasks.put(stale)
    await expect(chooseContinuation(stale.id, action, send)).rejects.toThrow(/篇章已变更/)
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('生成期间删除篇章不会重建任务或产生无法导入的孤立请求', async () => {
    const fetcher = fake('phoneReply')
    const task = await executeAuxiliary(
      archive.id,
      'phoneReply',
      '保留收到的结果',
      'character-shendu',
      {
        fetcher: async (url, init) => {
          const output = await fetcher(url, init)
          await db.transaction(
            'rw',
            [db.archives, db.messages, db.storyStates, db.storyEvents, db.tasks, db.requests],
            async () => {
              await db.archives.delete(archive.id)
              await db.messages.where('archiveId').equals(archive.id).delete()
              await db.storyStates.delete(archive.id)
              await db.storyEvents.where('archiveId').equals(archive.id).delete()
              await db.tasks.where('archiveId').equals(archive.id).delete()
              await db.requests.where('archiveId').equals(archive.id).delete()
            },
          )
          return output
        },
      },
    )
    expect(task.status).toBe('failed')
    expect(await db.archives.get(archive.id)).toBeUndefined()
    expect(await db.tasks.count()).toBe(0)
    expect(await db.messages.count()).toBe(0)
    const saved = await exportSave()
    expect(saved.requests.at(-1)?.archiveId).toBeNull()
    expect(saved.requests.at(-1)?.output).toBeTruthy()
    expect((await importSave(saved)).version).toBe(3)
    expect((await exportSave()).requests).toEqual(saved.requests)
  })
  it.each([
    'phoneReply',
    'forumReply',
    'search',
    'persona',
    'archiveMetadata',
    'continuation',
    'rewrite',
    'consistency',
    'contentImport',
    'chapters',
    'media',
    'command',
  ] as AuxiliaryKind[])('Responses %s 贯通冻结输入、严格请求与持久化结果', async (kind) => {
    const channel = { ...channelFixture, apiMode: 'responses' as const, temperature: null }
    await db.channels.put({
      ...channel,
      capability: {
        fingerprint: channelFingerprint(channel),
        catalogFingerprint: catalogFingerprintFixture,
        ok: true,
        testedAt: 0,
        protocol: 'responses',
        checks: { responses: { nonStreaming: 'passed', streaming: 'passed' } },
      },
    })
    const target =
      kind === 'phoneReply'
        ? 'character-shendu'
        : kind === 'forumReply'
          ? 'f:answer-0'
          : ['rewrite', 'media'].includes(kind)
            ? 'n'
            : null
    const task = await executeAuxiliary(archive.id, kind, '按当前剧情生成', target, {
      fetcher: fake(kind),
    })
    expect(task.status, task.error).toBe('complete')
    expect((await db.tasks.get(task.id))?.output).toEqual(task.output)
    expect((await db.requests.toArray())[0]).toMatchObject({
      channel: { protocol: 'responses' },
      request: { temperature: null, streaming: true },
      status: 'complete',
    })
  })
  it('所有根对象和嵌套对象严格且字段全部必填', () => {
    const walk = (node: unknown) => {
      if (!node || typeof node !== 'object') return
      const n = node as Record<string, unknown>
      if (n.type === 'object') {
        expect(n.additionalProperties).toBe(false)
        expect(n.required).toEqual(Object.keys(n.properties as object))
      }
      Object.values(n).forEach((v) => {
        if (Array.isArray(v)) v.forEach(walk)
        else walk(v)
      })
    }
    Object.values(taskSchemas).forEach((schema) => walk(z.toJSONSchema(schema)))
    expect(() =>
      validateTask('phoneReply', { contactRef: 'x', speaker: 'x', text: '内容' }),
    ).toThrow()
    expect(() =>
      validateTask('command', {
        action: 'unknown',
        targetId: null,
        mode: null,
        query: null,
        explanation: '操作',
      }),
    ).toThrow()
    expect(() =>
      validateTask('persona', {
        name: '',
        gender: '',
        identity: '读者',
        prefer: '',
        force: '规则',
      }),
    ).toThrow()
  })
  it('手机保存用户原文和一条联系人消息，刷新投影可复原', async () => {
    const task = await executeAuxiliary(
      archive.id,
      'phoneReply',
      ' 原文\n继续确认 ',
      'character-shendu',
      { fetcher: fake('phoneReply') },
    )
    expect(task.status).toBe('complete')
    expect(task.applied).toBe(true)
    const phone = (await db.storyStates.get(archive.id))!.phones[0]
    expect(phone.messages).toHaveLength(6)
    expect(phone.messages.at(-2)?.text).toBe(' 原文\n继续确认 ')
    expect(phone.messages.at(-1)?.speaker).toBe('沈渡')
    await applyTask(task.id)
    expect((await db.storyStates.get(archive.id))!.phones[0].messages).toHaveLength(6)
    const exported = await exportSave()
    await importSave(exported)
    expect((await db.storyStates.get(archive.id))!.phones[0]).toEqual(phone)
    expect(task.usage?.input).toBe(12000)
    expect((await db.channels.get('channel-1'))?.calibration?.samples).toBe(1)
  })
  it('论坛从50条持续累积，NPC回复关联目标用户回答', async () => {
    const task = await executeAuxiliary(archive.id, 'forumReply', '我选择散文集', 'f:answer-0', {
      fetcher: fake('forumReply'),
    })
    expect(task.applied).toBe(true)
    const answers = (await db.storyStates.get(archive.id))!.forums[0].answers
    expect(answers).toHaveLength(52)
    expect(answers[50].replyTo).toBe('f:answer-0')
    expect(answers[51].replyTo).toBe(answers[50].id)
    const second = await executeAuxiliary(archive.id, 'forumReply', '谢谢', answers[51].id, {
      fetcher: fake('forumReply'),
    })
    expect(second.applied).toBe(true)
    expect((await db.storyStates.get(archive.id))!.forums[0].answers).toHaveLength(54)
  })
  it('业务错误只纠正一次，不提交错误回复；截断和取消可恢复', async () => {
    const fetcher = fake('phoneReply', (output) => ({
      ...(output as object),
      contactRef: 'missing',
    }))
    const failed = await executeAuxiliary(archive.id, 'phoneReply', '你好', 'character-shendu', {
      fetcher,
    })
    expect(failed.status).toBe('failed')
    expect(failed.correction).toBeTruthy()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect((await db.storyStates.get(archive.id))!.phones[0].messages).toHaveLength(4)
    const truncated = await executeAuxiliary(archive.id, 'phoneReply', '你好', 'character-shendu', {
      fetcher: fake('phoneReply', undefined, 'length'),
    })
    expect(truncated.status).toBe('failed')
    expect(truncated.partial).toBeTruthy()
    const controller = new AbortController()
    controller.abort()
    const cancelled = await executeAuxiliary(archive.id, 'phoneReply', '你好', 'character-shendu', {
      signal: controller.signal,
      fetcher: fake('phoneReply'),
    })
    expect(cancelled.status).toBe('cancelled')
  })
  it.each([
    'persona',
    'archiveMetadata',
    'continuation',
    'search',
    'consistency',
    'chapters',
    'media',
    'command',
  ] as AuxiliaryKind[])('%s 生成严格结果并保存任务', async (kind) => {
    const task = await executeAuxiliary(
      archive.id,
      kind,
      '按当前剧情生成',
      kind === 'media' ? 'n' : null,
      { fetcher: fake(kind) },
    )
    expect(task.status, task.error).toBe('complete')
    expect((await db.tasks.get(task.id))?.output).toEqual(task.output)
    if (kind === 'persona' || kind === 'archiveMetadata') {
      await applyTask(task.id)
      if (kind === 'persona')
        expect((await db.personas.toArray()).some((p) => p.name === '林晚')).toBe(true)
      else expect((await db.archives.get(archive.id))?.description).toContain('书房')
    }
    expect((await db.storyStates.get(archive.id))!.events).toHaveLength(1)
  })
  it('资料提取先预览，应用后稳定引用与来源落库；旧应用存档不作为资料', async () => {
    const task = await executeAuxiliary(
      archive.id,
      'contentImport',
      '陆明是图书管理员，喜欢散文集。',
      null,
      { fetcher: fake('contentImport') },
    )
    expect(task.status).toBe('complete')
    expect((await db.storyStates.get(archive.id))!.entities.some((e) => e.name === '陆明')).toBe(
      false,
    )
    await applyTask(task.id)
    const state = (await db.storyStates.get(archive.id))!
    const entity = state.entities.find((e) => e.name === '陆明')!
    expect(entity.id).toBe(`task:${task.id}:entity:librarian`)
    expect(state.relationships[0].from).toBe(entity.id)
    expect(entity.source).toEqual({ messageId: `task:${task.id}`, blockId: null })
  })
  it('改写完整校验再原子应用，后续事件失效，原文仍保留', async () => {
    const task = await executeAuxiliary(archive.id, 'rewrite', '把午后改为傍晚', 'n', {
      fetcher: fake('rewrite'),
    })
    expect(task.status, task.error).toBe('complete')
    await applyTask(task.id)
    const history = await archiveMessages(archive.id)
    expect(
      history[1].reply?.kind === 'narrative' && history[1].reply.value.blocks[0].text,
    ).toContain('傍晚')
    expect(history[2].stale).toBe(true)
    expect(history[2].reply).toBeDefined()
    expect((await db.storyStates.get(archive.id))!.forums).toHaveLength(0)
    expect((await db.storyStates.get(archive.id))!.states[0].value).toBe('更加平静')
  })
  it('失效版本、伪造证据、无效关联与媒体曲目不能应用', async () => {
    const personaCount = await db.personas.count()
    const task = await executeAuxiliary(archive.id, 'persona', '生成读者', null, {
      fetcher: fake('persona'),
    })
    await appendMessage(messageFixture('new', 'user', '新的一轮', 3))
    await expect(applyTask(task.id)).rejects.toThrow(/变更/)
    expect(await db.personas.count()).toBe(personaCount)
    const invalidEvidence = fake('consistency', () => ({
      summary: '检查结果',
      issues: [
        {
          type: 'time',
          severity: 'warning',
          source: { messageId: 'n', blockId: 'b1' },
          evidence: '没有出现的原文',
          suggestion: '确认',
        },
      ],
    }))
    expect(
      (
        await executeAuxiliary(archive.id, 'consistency', '检查', null, {
          fetcher: invalidEvidence,
        })
      ).status,
    ).toBe('failed')
    expect(
      (
        await executeAuxiliary(archive.id, 'media', '配乐', 'n', {
          fetcher: fake('media', (v) => ({ ...(v as object), trackId: 'unknown' })),
        })
      ).status,
    ).toBe('failed')
    await editMessage('u', '修改前文')
    expect((await db.storyStates.get(archive.id))!.memories).toHaveLength(0)
  })
  it('Markdown 导出基于有效原文，章节不能编造或重复来源', async () => {
    const current = (await db.archives.get(archive.id))!
    const markdown = storyMarkdown(current, await archiveMessages(archive.id))
    expect(markdown).toContain('开始阅读')
    expect(markdown).toContain(narrativeFixture.blocks[1].text)
    const bad = await executeAuxiliary(archive.id, 'chapters', '整理', null, {
      fetcher: fake('chapters', () => ({
        title: '章节',
        chapters: [{ title: '第一章', summary: '摘要', messageIds: ['unknown'] }],
      })),
    })
    expect(bad.status).toBe('failed')
    expect(bad.error).toContain('未知')
  })
})

describe('独立交互与请求恢复边界', () => {
  it('收到部分输出后取消，用户原文与部分回复保留且不应用', async () => {
    const controller = new AbortController()
    const task = await executeAuxiliary(
      archive.id,
      'phoneReply',
      ' 保留原文 ',
      'character-shendu',
      {
        fetcher: fake('phoneReply'),
        signal: controller.signal,
        onPartial: () => controller.abort(),
      },
    )
    expect(task.status).toBe('cancelled')
    expect(task.input.text).toBe(' 保留原文 ')
    expect(task.partial).toBeTruthy()
    expect((await db.storyStates.get(archive.id))!.phones[0].messages).toHaveLength(4)
    const request = (await db.requests.toArray()).find((r) => r.ownerId === task.id)!
    expect(request.status).toBe('cancelled')
    expect(request.partial).toBeTruthy()
    const retry = await executeAuxiliary(
      archive.id,
      task.kind,
      task.input.text,
      task.input.targetId,
      { fetcher: fake('phoneReply') },
    )
    expect(retry.applied).toBe(true)
  })
  it('独立聊天可编辑结构化字段，修改后重建投影并失效后续记录', async () => {
    const task = await executeAuxiliary(archive.id, 'phoneReply', '你好', 'character-shendu', {
      fetcher: fake('phoneReply'),
    })
    const message = (await db.messages.get(`task:${task.id}`))!
    const interaction = { ...message.interaction!, userText: '编辑后的原文' }
    await appendMessage(messageFixture('after-phone', 'user', '后续消息', message.sequence + 1))
    await editMessage(message.id, JSON.stringify(interaction))
    expect((await db.storyStates.get(archive.id))!.phones[0].messages.at(-2)?.text).toBe(
      '编辑后的原文',
    )
    expect((await db.messages.get('after-phone'))?.stale).toBe(true)
    await expect(
      editMessage(message.id, JSON.stringify({ ...interaction, contactRef: 'unknown' })),
    ).rejects.toThrow(/不存在/)
    expect((await db.messages.get(message.id))!.interaction?.userText).toBe('编辑后的原文')
  })
  it('校验纠正的两次完整请求可重放，导出不包含认证头或 Key', async () => {
    let attempt = 0
    const task = await executeAuxiliary(archive.id, 'persona', '生成读者', null, {
      fetcher: fake('persona', (value) =>
        ++attempt === 1 ? { ...(value as object), name: '' } : value,
      ),
    })
    expect(task.status).toBe('complete')
    const records = (await db.requests.toArray())
      .filter((r) => r.ownerId === task.id)
      .sort((a, b) => a.attempt - b.attempt)
    expect(records).toHaveLength(2)
    expect(records[0].status).toBe('failed')
    expect(records[1].status).toBe('complete')
    expect(records[1].request.messages.slice(0, records[0].request.messages.length)).toEqual(
      records[0].request.messages,
    )
    expect(records[1].request.messages.at(-1)?.content).toContain('校验失败')
    expect(JSON.stringify(records)).not.toContain(channelFixture.apiKey)
    const exported = await exportSave()
    await importSave(exported)
    expect((await exportSave()).requests).toEqual(exported.requests)
  })
  it('资料入口拒绝旧应用存档；非法来源段落不产生资料记录', async () => {
    await expect(
      executeAuxiliary(
        archive.id,
        'contentImport',
        JSON.stringify({ version: 2, archives: [] }),
        null,
        { fetcher: fake('contentImport') },
      ),
    ).rejects.toThrow(/应用存档/)
    const task = await executeAuxiliary(archive.id, 'contentImport', '人物资料', null, {
      fetcher: fake('contentImport', (value) => {
        const v = structuredClone(value) as {
          effects: { entities: { sourceBlockId: string | null }[] }
        }
        v.effects.entities[0].sourceBlockId = 'missing'
        return v
      }),
    })
    expect(task.status).toBe('failed')
    expect((await db.storyStates.get(archive.id))!.entities.some((e) => e.name === '陆明')).toBe(
      false,
    )
  })
})

describe('创作和本地操作调度', () => {
  it('联系人消息采用请求冻结的人设姓名，后续切换不改变历史发送者', async () => {
    await db.personas.put({
      id: 'p',
      name: '林霁',
      gender: '女',
      identity: '研究者',
      prefer: '',
      force: '不代替用户决定',
      createdAt: 0,
    })
    await db.settings.update('app', { activePersonaId: 'p' })
    const task = await executeAuxiliary(archive.id, 'phoneReply', '确认安排', 'character-shendu', {
      fetcher: fake('phoneReply'),
    })
    expect((await db.messages.get(`task:${task.id}`))?.userName).toBe('林霁')
    expect((await db.storyStates.get(archive.id))!.phones[0].messages.at(-2)?.speaker).toBe('林霁')
  })
  it('操作不接受地点冒充人物；已删除篇章不能继续执行冻结操作', async () => {
    const invalid = await executeAuxiliary(archive.id, 'command', '打开人物', null, {
      fetcher: fake('command', () => ({
        action: 'character',
        targetId: 'location-manor',
        mode: null,
        query: null,
        explanation: '打开人物',
      })),
    })
    expect(invalid.status).toBe('failed')
    await db.archives.put({ ...archive, id: 'other' })
    const task = await executeAuxiliary(archive.id, 'command', '打开其他篇章', null, {
      fetcher: fake('command', () => ({
        action: 'archive',
        targetId: 'other',
        mode: null,
        query: null,
        explanation: '打开其他篇章',
      })),
    })
    expect(task.status).toBe('complete')
    await db.archives.delete('other')
    await expect(applyTask(task.id)).rejects.toThrow(/目标不存在/)
  })
})

describe('整份改写与问题位置校验', () => {
  it('媒体编辑重新校验描述和引用；原叙事失效后不会覆盖已有草稿', async () => {
    const task = await executeAuxiliary(archive.id, 'media', '当前场景', 'n', {
      fetcher: fake('media'),
    })
    const value = validateTask('media', task.output)
    const edited = { ...value, background: '编辑后的书房背景' }
    await saveMediaDraft(task.id, edited)
    expect((await db.tasks.get(task.id))?.output).toEqual(edited)
    await expect(saveMediaDraft(task.id, { ...value, background: '' })).rejects.toThrow()
    await expect(
      saveMediaDraft(task.id, {
        ...value,
        voice: [{ blockId: 'missing', speaker: '宴雎', direction: '低声' }],
      }),
    ).rejects.toThrow(/未知段落/)
    await editMessage('u', '改变原剧情')
    await expect(saveMediaDraft(task.id, value)).rejects.toThrow(/已失效/)
    expect((await db.tasks.get(task.id))?.output).toEqual(edited)
  })
  it('JSON 属性顺序不影响改写判断，重复修改引用会被拒绝', async () => {
    const target = (await db.messages.get('n'))!
    if (target.reply?.kind !== 'narrative') throw new Error('fixture')
    target.reply.value.blocks = target.reply.value.blocks.map((b) => ({
      translation: b.translation,
      text: b.text,
      kind: b.kind,
      speakerRef: b.speakerRef,
      id: b.id,
    }))
    await db.messages.put(target)
    const valid = await executeAuxiliary(archive.id, 'rewrite', '只改第一段', 'n', {
      fetcher: fake('rewrite'),
    })
    expect(valid.status, valid.error).toBe('complete')
    const invalid = await executeAuxiliary(archive.id, 'rewrite', '重复段落', 'n', {
      fetcher: fake('rewrite', (value) => ({
        ...(value as object),
        changedBlockIds: ['b1', 'b1'],
      })),
    })
    expect(invalid.status).toBe('failed')
    expect((await db.messages.get('n'))!.reply).toEqual(target.reply)
  })
  it('证据必须属于指定段落，不能引用另一段的句子', async () => {
    const task = await executeAuxiliary(archive.id, 'consistency', '检查', null, {
      fetcher: fake('consistency', () => ({
        summary: '检查结果',
        issues: [
          {
            type: 'character',
            severity: 'warning',
            source: { messageId: 'n', blockId: 'b1' },
            evidence: narrativeFixture.blocks[1].text,
            suggestion: '调整这句话',
          },
        ],
      })),
    })
    expect(task.status).toBe('failed')
    expect(task.error).toContain('段落不匹配')
  })
  it('关联字段校验失败不会覆盖原回复或失效后续事实', async () => {
    const task = await executeAuxiliary(archive.id, 'rewrite', '改写', 'n', {
      fetcher: fake('rewrite', (value) => {
        const v = structuredClone(value) as { replacement: typeof narrativeFixture }
        v.replacement.state.spokenLine = '正文里没有这句话'
        return v
      }),
    })
    expect(task.status).toBe('failed')
    expect((await db.messages.get('f'))?.stale).toBeUndefined()
    expect((await db.storyStates.get(archive.id))!.forums[0].answers).toHaveLength(50)
  })
})
