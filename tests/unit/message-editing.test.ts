import { describe, expect, it } from 'vitest'
import { emptyEffects } from '../../src/lib/domain-schema'
import { loadGameBranch, loadGameSave, saveGame } from '../../src/lib/game-history'
import { exportGame, importGame } from '../../src/lib/game-share'
import {
  appendMessage,
  archiveMessages,
  createArchive,
  db,
  editMessage,
  exportSave,
  importSave,
} from '../../src/lib/storage'
import { defaults } from '../../src/lib/types'
import { messageFixture } from '../fixtures'

describe('保留后续消息的历史编辑', () => {
  it.each(['user', 'assistant'] as const)(
    '修改历史 %s 只更改目标，路线、草稿、后续原文及独立存档保持',
    async (role) => {
      await db.settings.put(defaults)
      const archive = await createArchive('逐条修改')
      for (let i = 1; i <= 3; i++)
        await appendMessage({
          ...messageFixture(`m-${i}`, i === 1 ? role : 'user', `原文 ${i}`, i),
          archiveId: archive.id,
        })
      await db.archives.update(archive.id, { draft: '未发送的草稿' })
      const before = await archiveMessages(archive.id)
      const session = (await db.sessions.get(archive.id))!
      const slot = await saveGame(archive.id, '修改之前')
      await editMessage('m-1', '修改后的原文', 'preserve')
      const updated = await archiveMessages(archive.id)
      expect(updated.filter((m) => m.id !== 'm-1')).toEqual(before.filter((m) => m.id !== 'm-1'))
      expect(updated.find((m) => m.id === 'm-1')).toMatchObject({
        content: '修改后的原文',
        role,
        sequence: 1,
      })
      expect((await db.archives.get(archive.id))?.draft).toBe('未发送的草稿')
      expect((await db.sessions.get(archive.id))?.branchId).toBe(session.branchId)
      await loadGameBranch(archive.id, session.branchId)
      expect(await archiveMessages(archive.id)).toEqual(updated)
      await loadGameSave(archive.id, slot.id)
      expect(await archiveMessages(archive.id)).toEqual(before)
    },
  )

  it('移除旧实体只清理后续状态投影的失效引用，原文和备份分享仍完整，新的无效引用仍拒绝', async () => {
    await db.settings.put(defaults)
    const archive = await createArchive('修改实体来源')
    await appendMessage({
      ...messageFixture('source', 'assistant', '访客', 1),
      archiveId: archive.id,
      kind: 'material',
      effects: {
        ...emptyEffects(),
        entities: [
          {
            ref: 'new:guest',
            kind: 'character',
            name: '访客',
            description: '过路的访客',
            sourceBlockId: null,
          },
        ],
      },
    })
    await appendMessage({
      ...messageFixture('later', 'assistant', '后续保持原样', 2),
      archiveId: archive.id,
      kind: 'material',
      effects: {
        ...emptyEffects(),
        states: [
          { entityRef: 'source:entity:guest', key: '心情', value: '平静', sourceBlockId: null },
        ],
      },
    })
    const later = await db.messages.get('later')
    await editMessage(
      'source',
      JSON.stringify({ content: '没有访客', effects: emptyEffects() }),
      'preserve',
    )
    expect(await db.messages.get('later')).toEqual(later)
    expect((await db.storyStates.get(archive.id))?.states).toEqual([])
    await importSave(await exportSave())
    expect(await db.messages.get('later')).toEqual(later)
    const imported = await importGame(await exportGame(archive.id))
    expect((await archiveMessages(imported.id)).map((m) => m.content)).toContain('后续保持原样')
    await expect(
      appendMessage({
        ...messageFixture('invalid', 'assistant', '', 3),
        archiveId: archive.id,
        kind: 'material',
        effects: {
          ...emptyEffects(),
          states: [
            { entityRef: 'source:entity:guest', key: '心情', value: '开心', sourceBlockId: null },
          ],
        },
      }),
    ).rejects.toThrow('实体引用不存在')
  })
})
