import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  archiveMessages,
  db,
  importSave,
  appendMessage,
  editMessage,
  exportSave,
} from '../../src/lib/db'
import { applyTask, executeAuxiliary, storyMarkdown } from '../../src/lib/workflows'
import { taskSchemas, validateTask, type AuxiliaryKind, type TaskInput } from '../../src/lib/tasks'
import { channelFingerprint } from '../../src/lib/provider'
import { defaults, type StoredMessage } from '../../src/lib/types'
import { channelFixture, messageFixture, narrativeFixture, forumFixture, sse } from '../fixtures'
import { auxiliaryFixture } from '../auxiliary-fixtures'

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
  })
  await db.channels.update('channel-1', {
    capability: { fingerprint: channelFingerprint(channelFixture), ok: true, testedAt: 0 },
  })
})
function fake(
  kind: AuxiliaryKind,
  transform?: (output: unknown, input: TaskInput) => unknown,
  finish = 'stop',
) {
  return vi.fn<typeof fetch>(async (_url, options) => {
    const body = JSON.parse(String(options?.body))
    expect(body.response_format.type).toBe('json_schema')
    expect(body.response_format.json_schema.strict).toBe(true)
    const input = JSON.parse(body.messages[1].content) as TaskInput
    const output = auxiliaryFixture(kind, input)
    return new Response(sse(transform ? transform(output, input) : output, finish).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    })
  })
}
describe('辅助任务完整链路', () => {
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
      if (kind === 'persona') expect((await db.personas.toArray())[0].name).toBe('林晚')
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
    const task = await executeAuxiliary(archive.id, 'persona', '生成读者', null, {
      fetcher: fake('persona'),
    })
    await appendMessage(messageFixture('new', 'user', '新的一轮', 3))
    await expect(applyTask(task.id)).rejects.toThrow(/变更/)
    expect(await db.personas.count()).toBe(0)
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
