import { describe, expect, it, vi } from 'vitest'
import {
  db,
  createArchive,
  appendMessage,
  archiveMessages,
  editMessage,
  exportSave,
  importSave,
} from '../../src/lib/storage'
import {
  forkGame,
  navigateGame,
  loadGameSave,
  loadGameBranch,
  nodeForMessage,
  saveGame,
  updateGameContext,
  deleteGameBranch,
} from '../../src/lib/game-history'
import { exportGame, importGame } from '../../src/lib/game-share'
import { defaultStoryContent } from '../../src/lib/game-content'
import { buildInstructions } from '../../src/lib/prompts'
import { defaults } from '../../src/lib/types'
import { storyContext } from '../../src/lib/story'
import { saveDraft, retryDrafts, withPendingDrafts } from '../../src/lib/draft-storage'
import { channelFixture, messageFixture, narrativeFixture } from '../fixtures'

async function game() {
  await db.settings.put(defaults)
  return createArchive('测试篇章')
}
async function turn(archiveId: string, text: string) {
  const messages = await archiveMessages(archiveId)
  const sequence = messages.length
  const user = { ...messageFixture(crypto.randomUUID(), 'user', text, sequence), archiveId }
  const reply = {
    ...messageFixture(crypto.randomUUID(), 'assistant', `回复：${text}`, sequence + 1),
    archiveId,
    kind: 'notice' as const,
  }
  await appendMessage(user)
  await appendMessage(reply)
  return reply
}
describe('文字游戏存档和路线', () => {
  it('草稿写入失败可导出内存中的最新输入，重试后保存；旧草稿不得覆盖读档位置', async () => {
    const archive = await game()
    const fail = vi.spyOn(db.archives, 'update').mockRejectedValueOnce(new Error('写入失败'))
    await expect(saveDraft(archive.id, '需要恢复的草稿')).rejects.toThrow('写入失败')
    fail.mockRestore()
    expect(withPendingDrafts(await exportSave()).archives[0].draft).toBe('需要恢复的草稿')
    await retryDrafts()
    expect((await db.archives.get(archive.id))?.draft).toBe('需要恢复的草稿')
    const root = (await db.sessions.get(archive.id))!
    await navigateGame(archive.id, root.nodeId, root.branchId)
    await saveDraft(archive.id, '旧页面迟到的草稿', 0)
    expect((await db.archives.get(archive.id))?.draft).toBe('')
  })
  it('草稿与中断回合不会创建正式节点，切换路线恢复部分内容且保留手动存档', async () => {
    const archive = await game()
    await turn(archive.id, '已完成回合')
    const original = (await db.sessions.get(archive.id))!
    const nodeCount = await db.nodes.count()
    await db.archives.update(archive.id, { draft: '未发送草稿' })
    await appendMessage({
      ...messageFixture('pending-user', 'user', '未完成问题', 3),
      archiveId: archive.id,
    })
    await db.messages.put({
      ...messageFixture('pending-reply', 'assistant', '', 4),
      archiveId: archive.id,
      status: 'partial',
      partial: { kind: 'narrative', value: { scene: { time: '部分场景' } } },
    })
    const saved = await saveGame(archive.id, '中断点')
    expect(await db.nodes.count()).toBe(nodeCount)
    expect((await db.sessions.get(archive.id))?.nodeId).toBe(original.nodeId)
    const fork = await forkGame(archive.id, original.startNodeId)
    await loadGameBranch(archive.id, original.branchId)
    expect((await archiveMessages(archive.id)).at(-1)).toMatchObject({
      status: 'cancelled',
      partial: { value: { scene: { time: '部分场景' } } },
    })
    expect((await db.archives.get(archive.id))?.draft).toBe('未发送草稿')
    await loadGameBranch(archive.id, fork.id)
    await deleteGameBranch(archive.id, original.branchId)
    expect(await db.slots.get(saved.id)).toBeDefined()
    const imported = await importGame(await exportGame(archive.id, 'progress', 'game'))
    const copiedSlot = (await db.slots.where('archiveId').equals(imported.id).toArray()).find(
      (slot) => slot.name === saved.name,
    )!
    expect(copiedSlot.branchId).not.toBe(saved.branchId)
    await loadGameSave(imported.id, copiedSlot.id)
    expect((await archiveMessages(imported.id)).at(-1)?.partial).toEqual({
      kind: 'narrative',
      value: { scene: { time: '部分场景' } },
    })
    await loadGameSave(archive.id, saved.id)
    expect((await archiveMessages(archive.id)).at(-1)?.id).toBe('pending-reply')
    expect((await db.branches.get((await db.sessions.get(archive.id))!.branchId))?.name).toBe(
      '恢复的路线',
    )
  })
  it('编辑过去的回复使用当时的设定，人设和后来的摘要不会进入新路线', async () => {
    const archive = await game()
    const originalContent = archive.content!
    const early = await turn(archive.id, '较早的剧情')
    await updateGameContext(
      archive.id,
      { ...originalContent, character: '未来才出现的设定' },
      {
        id: 'future',
        name: '未来人设',
        gender: '',
        identity: '',
        prefer: '',
        force: '',
        createdAt: 1,
      },
    )
    const point = await nodeForMessage(archive.id, early.id)
    const context = (await db.contexts.get(point.contextId))!
    expect(context.content.character).toBe(originalContent.character)
    expect(context.persona?.name).not.toBe('未来人设')
    await turn(archive.id, '未来的剧情')
    await editMessage(early.id, '另一种回复')
    expect((await db.archives.get(archive.id))?.content?.character).toBe(originalContent.character)
    expect((await db.archives.get(archive.id))?.persona?.name).not.toBe('未来人设')
    expect((await archiveMessages(archive.id)).some((m) => m.content.includes('未来的剧情'))).toBe(
      false,
    )
  })
  it('批量导入的历史中，每个已完成回复仍可独立回退', async () => {
    const archive = await game()
    const first = await turn(archive.id, '第一轮')
    await turn(archive.id, '第二轮')
    const backup = await exportSave()
    backup.history = {
      sessions: [],
      branches: [],
      nodes: [],
      contexts: [],
      messageVersions: [],
      taskVersions: [],
      slots: [],
      stateVersions: [],
    }
    await importSave(backup)
    const session = (await db.sessions.get(archive.id))!
    const point = await nodeForMessage(archive.id, first.id)
    await navigateGame(archive.id, point.id, session.branchId)
    expect((await archiveMessages(archive.id)).at(-1)?.id).toBe(first.id)
    await loadGameBranch(archive.id, session.branchId)
    expect((await archiveMessages(archive.id)).at(-1)?.content).toBe('回复：第二轮')
  })
  it('超过20个自动存档仍可回到开局，后续推进自动分支，原未来可载入', async () => {
    const archive = await game()
    const start = (await db.sessions.get(archive.id))!
    for (let i = 0; i < 25; i++) await turn(archive.id, `第${i}轮`)
    const original = (await db.sessions.get(archive.id))!
    expect(
      await db.slots.where('[branchId+kind]').equals([original.branchId, 'auto']).count(),
    ).toBe(20)
    expect(await db.nodes.where('archiveId').equals(archive.id).count()).toBe(26)
    await navigateGame(archive.id, start.nodeId, original.branchId)
    expect(await archiveMessages(archive.id)).toHaveLength(1)
    await turn(archive.id, '另一个选择')
    const fork = (await db.sessions.get(archive.id))!
    expect(fork.branchId).not.toBe(original.branchId)
    expect((await db.nodes.get(fork.nodeId))?.parentId).toBe(start.nodeId)
    expect(await db.branches.where('archiveId').equals(archive.id).count()).toBe(2)
    await navigateGame(archive.id, original.nodeId, original.branchId)
    expect((await archiveMessages(archive.id)).at(-1)?.content).toBe('回复：第24轮')
  })
  it('手动覆盖和快速存档均恢复完整关系、人设、设定、草稿与任务状态', async () => {
    const archive = await game()
    const content = {
      ...defaultStoryContent(),
      character: '分享角色设定',
      world: [{ label: '世界', text: '一个独立世界' }],
      background: 'data:image/png;base64,aGVsbG8=',
    }
    const persona = {
      id: 'mask',
      name: '玩家甲',
      gender: '未知',
      identity: '读者',
      prefer: '喝茶',
      force: '不要代替我行动',
      createdAt: 1,
    }
    await updateGameContext(archive.id, content, persona)
    const messages = await archiveMessages(archive.id)
    await appendMessage({
      ...messageFixture('u', 'user', '开始', messages.length),
      archiveId: archive.id,
    })
    await appendMessage({
      ...messageFixture('n', 'assistant', JSON.stringify(narrativeFixture), messages.length + 1),
      archiveId: archive.id,
      reply: { kind: 'narrative', value: narrativeFixture },
    })
    await db.archives.update(archive.id, { draft: '未发送草稿' })
    const before = (await db.storyStates.get(archive.id))!
    await db.tasks.put({
      id: 'saved-task',
      archiveId: archive.id,
      revision: (await db.archives.get(archive.id))!.revision,
      kind: 'search',
      channelId: 'private-channel',
      createdAt: 1,
      status: 'complete',
      applied: true,
      input: {
        text: '查看已知事实',
        targetId: null,
        context: {
          archive: { id: archive.id, name: archive.name },
          persona,
          setting: content,
          story: storyContext(before),
          target: narrativeFixture,
          phone: null,
          forum: null,
          archives: [{ id: archive.id, name: archive.name }],
          tracks: [],
          history: [],
        },
      },
      output: {
        entityRefs: ['character-yanju'],
        terms: ['阅读'],
        fromDate: null,
        toDate: null,
        category: 'all',
      },
    })
    const saved = await saveGame(archive.id, '午后')
    await turn(archive.id, '后续')
    const quick = await saveGame(archive.id, '快速存档', 'quick')
    await saveGame(archive.id, '快速存档', 'quick')
    expect(
      await db.slots
        .where('archiveId')
        .equals(archive.id)
        .filter((s) => s.kind === 'quick')
        .count(),
    ).toBe(1)
    await loadGameSave(archive.id, saved.id)
    const restored = (await db.archives.get(archive.id))!
    expect(restored.persona).toEqual(persona)
    expect(restored.content).toEqual(content)
    expect(restored.draft).toBe('未发送草稿')
    expect((await db.storyStates.get(archive.id))?.relationships).toEqual(before.relationships)
    const state = (await db.storyStates.get(archive.id))!
    for (const key of [
      'clock',
      'memories',
      'goals',
      'phones',
      'forums',
      'knowledge',
      'events',
    ] as const)
      expect(state[key]).toEqual(before[key])
    expect(await db.tasks.get('saved-task')).toMatchObject({ status: 'complete', applied: true })
    expect(buildInstructions(restored.persona, 'narrative', restored.content)).toContain(
      '分享角色设定',
    )
    const overwritten = await saveGame(archive.id, '午后', 'manual', saved.id)
    expect(overwritten.id).toBe(saved.id)
    await db.branches.delete(quick.branchId)
    await loadGameSave(archive.id, quick.id)
    expect((await archiveMessages(archive.id)).at(-1)?.content).toBe('回复：后续')
    expect((await db.branches.toArray()).some((b) => b.name === '恢复的路线')).toBe(true)
  })
  it('历史编辑创建路线，失败校验不改变游玩位置，原消息版本保持不变', async () => {
    const archive = await game()
    const message = await turn(archive.id, '第一轮')
    await turn(archive.id, '第二轮')
    const original = (await db.sessions.get(archive.id))!
    await editMessage(message.id, '改写后的回复')
    expect((await archiveMessages(archive.id)).at(-1)?.content).toBe('改写后的回复')
    expect((await db.sessions.get(archive.id))?.branchId).not.toBe(original.branchId)
    await navigateGame(archive.id, original.nodeId, original.branchId)
    expect((await archiveMessages(archive.id)).find((m) => m.id === message.id)?.content).toBe(
      '回复：第一轮',
    )
    expect((await archiveMessages(archive.id)).at(-1)?.content).toBe('回复：第二轮')
  })
  it('节点提交失败原子回滚消息和路线指针', async () => {
    const archive = await game()
    const before = (await db.sessions.get(archive.id))!
    const failure = vi.spyOn(db.nodes, 'add').mockRejectedValueOnce(new Error('空间不足'))
    await expect(
      appendMessage({
        ...messageFixture('fail', 'assistant', '回复', 1),
        archiveId: archive.id,
        kind: 'notice',
      }),
    ).rejects.toThrow('空间不足')
    failure.mockRestore()
    expect(await db.messages.get('fail')).toBeUndefined()
    expect(await db.sessions.get(archive.id)).toEqual(before)
  })
})
describe('独立剧情包', () => {
  it('开局、单路线与全部路线往返；所有分享结构排除模型和认证资料', async () => {
    const archive = await game()
    await db.channels.put({
      ...channelFixture,
      apiKey: '__KEY_SENTINEL__',
      model: '__MODEL_SENTINEL__',
    })
    const response = await turn(archive.id, '分享前')
    await db.messages.update(response.id, {
      diagnostics: {
        startedAt: 1,
        elapsedMs: 1,
        model: '__MODEL_SENTINEL__',
        schema: 'narrative',
        corrections: 0,
      },
      usage: {
        input: 1,
        output: 1,
        total: 2,
        measuredAt: 1,
        estimatedInput: 1,
        channelId: '__CHANNEL_SENTINEL__',
      },
    })
    const slot = await saveGame(archive.id, '分享存档')
    await forkGame(archive.id)
    await turn(archive.id, '分支进度')
    const settings = (await db.settings.get('app'))!
    for (const [mode, scope, expectedBranches] of [
      ['start', 'route', 1],
      ['progress', 'route', 1],
      ['progress', 'game', 2],
    ] as const) {
      const pkg = await exportGame(archive.id, mode, scope)
      const json = JSON.stringify(pkg)
      for (const sentinel of [
        '__KEY_SENTINEL__',
        '__MODEL_SENTINEL__',
        '__CHANNEL_SENTINEL__',
        'apiKey',
        'baseUrl',
        'diagnostics',
        'channelId',
      ])
        expect(json).not.toContain(sentinel)
      const imported = await importGame(JSON.parse(json))
      expect(imported.id).not.toBe(archive.id)
      expect(await db.branches.where('archiveId').equals(imported.id).count()).toBe(
        expectedBranches,
      )
      const history = await archiveMessages(imported.id)
      expect(history.at(-1)?.content).toBe(
        mode === 'start' ? archive.content!.opening : '回复：分支进度',
      )
      expect(await db.settings.get('app')).toEqual(settings)
      if (scope === 'game')
        expect(
          (await db.slots.where('archiveId').equals(imported.id).toArray()).some(
            (s) => s.name === slot.name,
          ),
        ).toBe(true)
    }
  })
  it('损坏的历史引用、循环和内容在导入前拒绝，不写入部分篇章', async () => {
    const archive = await game()
    await turn(archive.id, '一轮')
    const pkg = await exportGame(archive.id)
    const count = await db.archives.count()
    pkg.history.nodes[0].parentId = pkg.history.nodes[0].id
    await expect(importGame(pkg)).rejects.toThrow(/循环/)
    expect(await db.archives.count()).toBe(count)
  })
  it('状态快照不能带入不属于当前剧情的未来事实', async () => {
    const archive = await game()
    const pkg = await exportGame(archive.id)
    const count = await db.archives.count()
    pkg.history.stateVersions[0].state.clock.dateTime = '2099-01-01T00:00:00'
    await expect(importGame(pkg)).rejects.toThrow(/状态快照/)
    expect(await db.archives.count()).toBe(count)
  })
  it('个人备份中隐藏路线的损坏内容也会在事务前拒绝', async () => {
    const archive = await game()
    const old = await turn(archive.id, '旧路线')
    await forkGame(archive.id)
    await editMessage(old.id, '新版本')
    const backup = await exportSave()
    const hidden = backup.history.messageVersions.find(
      (v) => v.value.id === old.id && v.value.content === '回复：旧路线',
    )!
    hidden.value.status = 'unknown' as never
    const count = await db.archives.count()
    await expect(importSave(backup)).rejects.toThrow()
    expect(await db.archives.count()).toBe(count)
    expect((await archiveMessages(archive.id)).at(-1)?.content).toBe('新版本')
  })
  it('个人全量备份和合并导入保留整棵路线树与手动存档', async () => {
    const archive = await game()
    await turn(archive.id, '原路线')
    await saveGame(archive.id, '重要进度')
    await forkGame(archive.id)
    await turn(archive.id, '新路线')
    const backup = await exportSave()
    await importSave(JSON.parse(JSON.stringify(backup)))
    expect(await db.branches.where('archiveId').equals(archive.id).count()).toBe(2)
    expect(
      await db.slots
        .where('archiveId')
        .equals(archive.id)
        .filter((s) => s.kind === 'manual')
        .count(),
    ).toBe(1)
    const merged = await importSave(JSON.parse(JSON.stringify(backup)), db, false, 'merge')
    const imported = merged.archives[0].id
    expect(imported).not.toBe(archive.id)
    expect(await db.branches.where('archiveId').equals(imported).count()).toBe(2)
  })
})
