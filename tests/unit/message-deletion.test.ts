import { describe, expect, it } from 'vitest'
import { emptyEffects } from '../../src/lib/domain-schema'
import { loadGameBranch, loadGameSave, saveGame } from '../../src/lib/game-history'
import { exportGame, importGame } from '../../src/lib/game-share'
import {
  appendMessage,
  archiveMessages,
  commitSummary,
  createArchive,
  db,
  deleteMessage,
  exportSave,
  importSave,
} from '../../src/lib/storage'
import { defaults } from '../../src/lib/types'
import { compressionFixture, forumFixture, messageFixture, narrativeFixture } from '../fixtures'

async function game() {
  await db.settings.put(defaults)
  return createArchive('逐条删除测试')
}

describe('逐条删除聊天消息', () => {
  it('删除中间消息只改变目标记录，后续原文、序号与完成状态保持不变', async () => {
    const archive = await game()
    for (let index = 1; index <= 3; index++)
      await appendMessage({
        ...messageFixture(
          `message-${index}`,
          index === 2 ? 'assistant' : 'user',
          `内容 ${index}`,
          index,
        ),
        archiveId: archive.id,
      })
    await commitSummary(archive.id, 3, {
      value: compressionFixture,
      coveredThroughId: 'message-2',
      coveredCount: 3,
      revision: 3,
      createdAt: 1,
    })
    const before = await archiveMessages(archive.id)
    await deleteMessage('message-2')
    expect(await archiveMessages(archive.id)).toEqual(
      before.filter((message) => message.id !== 'message-2'),
    )
    expect((await db.archives.get(archive.id))?.summary).toBeUndefined()
    expect((await db.archives.get(archive.id))?.deletedMessageIds).toEqual(['message-2'])
    const session = (await db.sessions.get(archive.id))!
    await loadGameBranch(archive.id, session.branchId)
    expect(await archiveMessages(archive.id)).toEqual(
      before.filter((message) => message.id !== 'message-2'),
    )
    expect(await db.messages.get('message-2')).toBeUndefined()
  })

  it('删除实体来源仍保留其他消息，剔除失去来源的引用，并支持备份、分享和原存档恢复', async () => {
    const archive = await game()
    await appendMessage({
      ...messageFixture('source', 'assistant', '访客到来', 1),
      archiveId: archive.id,
      kind: 'material',
      effects: {
        ...emptyEffects(),
        entities: [
          {
            ref: 'new:guest',
            kind: 'character',
            name: '访客',
            description: '过路人',
            sourceBlockId: null,
          },
        ],
      },
    })
    await appendMessage({
      ...messageFixture('later', 'assistant', '后续内容保持原样', 2),
      archiveId: archive.id,
      kind: 'material',
      effects: {
        ...emptyEffects(),
        states: [
          { entityRef: 'source:entity:guest', key: '心情', value: '平静', sourceBlockId: null },
        ],
        memories: [
          {
            ...narrativeFixture.effects.memories[0],
            ref: 'new:kept',
            content: '与访客无关的事实',
            entityRefs: [],
            sourceBlockId: null,
          },
        ],
      },
    })
    const saved = await saveGame(archive.id, '删除之前')
    const later = await db.messages.get('later')
    await deleteMessage('source')
    expect(await db.messages.get('later')).toEqual(later)
    expect(
      (await db.storyStates.get(archive.id))?.entities.some(
        (entity) => entity.id === 'source:entity:guest',
      ),
    ).toBe(false)
    expect((await db.storyStates.get(archive.id))?.states).toHaveLength(0)
    expect(
      (await db.storyStates.get(archive.id))?.memories.map((memory) => memory.content),
    ).toContain('与访客无关的事实')
    const backup = await exportSave()
    await importSave(backup)
    expect(await db.messages.get('source')).toBeUndefined()
    expect(await db.messages.get('later')).toEqual(later)
    const shared = await importGame(await exportGame(archive.id, 'progress', 'game'))
    expect((await archiveMessages(shared.id)).map((message) => message.content)).toContain(
      '后续内容保持原样',
    )
    expect(
      (await archiveMessages(shared.id)).some((message) => message.content === '访客到来'),
    ).toBe(false)
    await loadGameSave(archive.id, saved.id)
    expect(await db.messages.get('source')).toBeDefined()
  })

  it('删除手机和论坛来源仍保留后续独立交互记录，继续提交仍严格校验引用', async () => {
    for (const kind of ['phone', 'forum'] as const) {
      const archive = await game()
      const sourceId = `source-${kind}`
      await appendMessage({
        ...messageFixture(sourceId, 'assistant', '', 1),
        archiveId: archive.id,
        reply:
          kind === 'phone'
            ? { kind: 'narrative', value: structuredClone(narrativeFixture) }
            : { kind: 'forum', value: structuredClone(forumFixture) },
      })
      const interaction =
        kind === 'phone'
          ? {
              kind,
              contactRef: narrativeFixture.phone.conversations[0].contactRef,
              userText: '保留的问题',
              speaker: '宴雎',
              time: '14:00',
              text: '保留的回复',
            }
          : {
              kind,
              postId: `${sourceId}:post`,
              replyTo: `${sourceId}:post`,
              userText: '保留的问题',
              author: '读者',
              time: '14:00',
              content: '保留的回复',
            }
      await appendMessage({
        ...messageFixture(`later-${kind}`, 'assistant', '独立交互内容', 2),
        archiveId: archive.id,
        kind: 'interaction',
        interaction,
      })
      const later = await db.messages.get(`later-${kind}`)
      await deleteMessage(sourceId)
      expect(await db.messages.get(`later-${kind}`)).toEqual(later)
      expect(await archiveMessages(archive.id)).toHaveLength(2)
      await expect(
        appendMessage({
          ...messageFixture(`invalid-${kind}`, 'assistant', '无效的新引用', 3),
          archiveId: archive.id,
          kind: 'material',
          effects: {
            ...emptyEffects(),
            states: [
              {
                entityRef: `${sourceId}:entity:missing`,
                key: '状态',
                value: '无效',
                sourceBlockId: null,
              },
            ],
          },
        }),
      ).rejects.toThrow('实体引用不存在')
      expect(await db.messages.get(`invalid-${kind}`)).toBeUndefined()
    }
  })

  it('删除最后一条未完成消息或全部消息后，路线切换不会恢复被删除的记录', async () => {
    const archive = await game()
    await appendMessage({
      ...messageFixture('pending', 'user', '尚未完成的回合', 1),
      archiveId: archive.id,
    })
    await deleteMessage('pending')
    const opening = (await archiveMessages(archive.id))[0]
    await deleteMessage(opening.id)
    expect(await archiveMessages(archive.id)).toEqual([])
    const session = (await db.sessions.get(archive.id))!
    await loadGameBranch(archive.id, session.branchId)
    expect(await archiveMessages(archive.id)).toEqual([])
    await appendMessage({
      ...messageFixture('new-turn', 'user', '重新开始', 0),
      archiveId: archive.id,
    })
    expect((await archiveMessages(archive.id)).map((message) => message.id)).toEqual(['new-turn'])
  })

  it('拒绝过期页面与其他窗口正在操作时的删除，事务失败不改变记录', async () => {
    const archive = await game()
    const opening = (await archiveMessages(archive.id))[0]
    await appendMessage({
      ...messageFixture('latest', 'user', '最新消息', 1),
      archiveId: archive.id,
    })
    await expect(deleteMessage(opening.id, archive.revision)).rejects.toThrow('其他窗口修改')
    await db.operations.put({
      archiveId: archive.id,
      owner: 'other-window',
      expiresAt: Date.now() + 60000,
    })
    await expect(deleteMessage(opening.id)).rejects.toThrow('另一个窗口操作')
    expect(await archiveMessages(archive.id)).toHaveLength(2)
    expect(await db.messages.get(opening.id)).toEqual(opening)
  })
})
