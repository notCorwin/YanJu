import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exportSave, initializeStorage, YanJuDatabase } from '../../src/lib/db'
import { OPFS_SAVE_FILE, OpfsPersistence } from '../../src/lib/opfs'
import { defaults, type SaveFile } from '../../src/lib/types'
import { channelFixture, messageFixture, narrativeFixture } from '../fixtures'
import { channelFingerprint, channelIsReady } from '../../src/lib/provider'
import { webcrypto } from 'node:crypto'

const save: SaveFile = {
  version: 2,
  exportedAt: '2026-10-08T00:00:00.000Z',
  archives: [{ id: 'archive-1', name: '篇章', createdAt: 1, updatedAt: 1, revision: 1, draft: '' }],
  messages: [
    {
      ...messageFixture('reply', 'assistant', JSON.stringify(narrativeFixture), 0),
      reply: { kind: 'narrative', value: narrativeFixture },
    },
  ],
  channels: [
    {
      ...channelFixture,
      capability: {
        fingerprint: channelFingerprint(channelFixture),
        ok: true,
        testedAt: 1,
        protocol: 'chat-completions',
        checks: { 'chat-completions': { nonStreaming: 'passed', streaming: 'passed' } },
      },
    },
  ],
  masks: [],
  settings: { ...defaults, activeArchiveId: 'archive-1', activeChannelId: channelFixture.id },
}

function mockStorage() {
  const files = new Map<string, string>()
  const close = vi.fn()
  const write = vi.fn()
  const abort = vi.fn()
  const directory = {
    removeEntry: vi.fn(async (name: string) => {
      files.delete(name)
    }),
    getFileHandle: vi.fn(async (name: string, options?: { create?: boolean }) => {
      if (!files.has(name)) {
        if (!options?.create) throw new DOMException('Not found', 'NotFoundError')
        files.set(name, '')
      }
      return {
        getFile: async () => ({ text: async () => files.get(name) }),
        createWritable: async () => {
          let pending = ''
          return {
            write: async (content: string) => {
              await write(content)
              pending = content
            },
            close: async () => {
              await close()
              files.set(name, pending)
            },
            abort,
          }
        },
      }
    }),
  }
  const storage = {
    getDirectory: vi.fn(async () => ({ getDirectoryHandle: async () => directory })),
    persisted: vi.fn(async () => false),
    persist: vi.fn(async () => false),
  }
  const locks = {
    request: vi.fn(
      async (
        name: string,
        optionsOrCallback: LockOptions | ((lock: Lock) => Promise<unknown>),
        callback?: (lock: Lock) => Promise<unknown>,
      ) => {
        const run = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback!
        return run({
          name,
          mode:
            typeof optionsOrCallback === 'function'
              ? 'exclusive'
              : (optionsOrCallback.mode ?? 'exclusive'),
        })
      },
    ),
  }
  vi.stubGlobal('navigator', { storage, locks, userAgent: navigator.userAgent })
  return { files, close, write, abort, storage, locks }
}

let mock: ReturnType<typeof mockStorage>
const stores: OpfsPersistence[] = []
const databases: YanJuDatabase[] = []
beforeEach(() => {
  mock = mockStorage()
  vi.stubGlobal('crypto', webcrypto)
})
afterEach(async () => {
  for (const store of stores.splice(0)) {
    await store.flush()
    store.stop()
  }
  for (const database of databases.splice(0)) await database.delete()
  vi.unstubAllGlobals()
})

function persistence(snapshot = vi.fn(async () => save)) {
  const store = new OpfsPersistence('test-save', snapshot)
  stores.push(store)
  return store
}

describe('OPFS 完整存档', () => {
  it('另一个窗口关闭后，仍从共享提交日志同步其最新消息', async () => {
    const name = `opfs-shared-${crypto.randomUUID()}`
    const first = new YanJuDatabase(name)
    const second = new YanJuDatabase(name)
    databases.push(first, second)
    stores.push(first.persistence, second.persistence)
    await first.settings.put({ ...save.settings })
    await first.archives.put(save.archives[0])
    await first.messages.bulkPut(save.messages)
    await initializeStorage(first)
    await second.open()
    await second.messages.put(
      messageFixture('from-closed-window', 'user', '另一个窗口留下的内容', 1),
    )
    await first.archives.update('archive-1', { draft: '当前窗口更新' })
    await first.persistence.flush()
    const restored = (await first.persistence.read()) as SaveFile
    expect(restored.messages.map((message) => message.id)).toEqual(['reply', 'from-closed-window'])
    expect(await first.persistenceChanges.count()).toBe(0)
  })
  it('消息文件缺失不会当作空存档，恢复备份保留原索引与文件', async () => {
    const original = new OpfsPersistence('damaged-incremental', async () => save, true)
    stores.push(original)
    await original.start()
    const manifest = JSON.parse(mock.files.get(OPFS_SAVE_FILE)!)
    const oldFile = manifest.messages[0].file
    mock.files.delete(oldFile)
    await expect(original.read()).rejects.toThrow(/Not found/)
    mock.files.set(oldFile, JSON.stringify(save.messages[0]))
    original.preserveUnreadableSave(new Error('需要保留原始文件'))
    original.markDirty()
    await original.flush()
    expect(JSON.parse(mock.files.get('save-recovery.json')!)).toEqual(manifest)
    expect(mock.files.has(oldFile)).toBe(true)
  })
  it('大量历史只同步变化的消息，草稿与背景修改不重新读取或写入历史', async () => {
    const database = new YanJuDatabase(`opfs-incremental-${crypto.randomUUID()}`)
    databases.push(database)
    stores.push(database.persistence)
    await database.settings.put({
      ...save.settings,
      bgImage: 'data:image/png;base64,' + 'A'.repeat(100000),
    })
    await database.archives.put(save.archives[0])
    const messages = Array.from({ length: 1000 }, (_, sequence) => ({
      ...messageFixture(
        `message-${sequence}`,
        'assistant',
        JSON.stringify(narrativeFixture),
        sequence,
      ),
      reply: { kind: 'narrative' as const, value: narrativeFixture },
    }))
    await database.messages.bulkPut(messages)
    await initializeStorage(database)
    const before = JSON.parse(mock.files.get(OPFS_SAVE_FILE)!)
    const allHistory = vi.spyOn(database.messages, 'toArray')
    mock.write.mockClear()
    await database.archives.update('archive-1', { draft: '新的草稿' })
    await database.persistence.flush()
    const afterDraft = JSON.parse(mock.files.get(OPFS_SAVE_FILE)!)
    expect(afterDraft.messages).toEqual(before.messages)
    expect(afterDraft.backgroundFile).toBe(before.backgroundFile)
    expect(allHistory).not.toHaveBeenCalled()
    expect(mock.write).toHaveBeenCalledOnce()
    expect(String(mock.write.mock.calls[0][0])).not.toContain('A'.repeat(100000))
    mock.write.mockClear()
    await database.messages.update('message-500', { error: '变化的消息' })
    await database.persistence.flush()
    expect(allHistory).not.toHaveBeenCalled()
    expect(mock.write).toHaveBeenCalledTimes(2)
    const restored = (await database.persistence.read()) as SaveFile
    expect(restored.messages).toHaveLength(1000)
    expect(restored.messages.find((message) => message.id === 'message-500')?.error).toBe(
      '变化的消息',
    )
    const written = mock.write.mock.calls.length
    await database.persistence.flush()
    expect(mock.write).toHaveBeenCalledTimes(written)
  })
  it('新消息文件写完后索引提交失败，旧存档仍完整且重试可恢复', async () => {
    let current = save
    const store = new OpfsPersistence(
      'incremental-failure',
      async (ids) => ({
        ...current,
        messages:
          ids === undefined
            ? current.messages
            : current.messages.filter((message) => ids.includes(message.id)),
      }),
      true,
    )
    stores.push(store)
    await store.start()
    current = { ...save, messages: [{ ...save.messages[0], error: '新内容' }] }
    store.markDirty(['reply'])
    mock.close
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new DOMException('磁盘已满', 'QuotaExceededError'))
    expect((await store.flush()).phase).toBe('error')
    expect(await store.read()).toEqual(save)
    expect((await store.flush()).phase).toBe('saved')
    expect(await store.read()).toEqual(current)
  })
  it('未获持久存储授权仍原子保存完整回复，支持重新读取', async () => {
    const store = persistence()
    await store.start()
    expect(mock.storage.persist).toHaveBeenCalledOnce()
    expect(store.getStatus()).toEqual({ phase: 'saved', persistent: false, error: undefined })
    expect(await store.read()).toEqual(save)
    expect(mock.close).toHaveBeenCalledOnce()
    expect(mock.locks.request).toHaveBeenCalledWith('yanju-opfs:test-save', expect.any(Function))
  })

  it('OPFS 不受支持时保留工作数据库，不误报已同步', async () => {
    vi.stubGlobal('navigator', { storage: {} })
    const store = persistence()
    await store.start()
    expect((await store.flush()).phase).toBe('unavailable')
    expect(mock.write).not.toHaveBeenCalled()
  })

  it('关闭文件失败时保留上次完整文件，随后可重试新存档', async () => {
    let current = save
    const store = persistence(vi.fn(async () => current))
    await store.start()
    current = { ...save, archives: [{ ...save.archives[0], name: '新篇章' }] }
    store.markDirty()
    mock.close.mockRejectedValueOnce(new DOMException('磁盘已满', 'QuotaExceededError'))
    expect((await store.flush()).phase).toBe('error')
    expect(await store.read()).toEqual(save)
    expect(mock.abort).toHaveBeenCalledOnce()
    expect((await store.flush()).phase).toBe('saved')
    expect(await store.read()).toEqual(current)
  })

  it('写入期间发生的新提交会继续同步，flush 等到最新内容落盘', async () => {
    let current = save
    const store = persistence(vi.fn(async () => current))
    await store.start()
    mock.write.mockImplementationOnce(async () => {
      current = { ...save, archives: [{ ...save.archives[0], draft: '最新草稿' }] }
      store.markDirty()
    })
    store.markDirty()
    await store.flush()
    expect(await store.read()).toEqual(current)
    expect(mock.write).toHaveBeenCalledTimes(3)
  })

  it.each(['responses', 'chat-completions'] as const)(
    '空工作数据库从 OPFS 恢复结构化回复、草稿与 %s 渠道测试状态',
    async (protocol) => {
      const channel = { ...channelFixture, apiMode: 'auto' as const, temperature: null }
      const snapshot = {
        ...save,
        channels: [
          {
            ...channel,
            capability: {
              fingerprint: channelFingerprint(channel),
              ok: true,
              testedAt: 1,
              protocol,
              checks: { [protocol]: { nonStreaming: 'passed', streaming: 'passed' } },
            },
          },
        ],
      }
      mock.files.set(OPFS_SAVE_FILE, JSON.stringify(snapshot))
      const database = new YanJuDatabase(`opfs-recovery-${crypto.randomUUID()}`)
      databases.push(database)
      stores.push(database.persistence)
      await initializeStorage(database)
      const recovered = await exportSave(database)
      expect(recovered.messages).toEqual(save.messages)
      expect(recovered.archives[0].name).toBe(save.archives[0].name)
      expect(recovered.channels).toEqual(snapshot.channels)
      expect(channelIsReady(recovered.channels[0])).toBe(true)
      expect(recovered.settings.activeArchiveId).toBe('archive-1')
    },
  )

  it('无法解析的旧 OPFS 文件先保留恢复副本，仍可打开并保存新篇章', async () => {
    const unreadable = '{"version":2,"messages":'
    mock.files.set(OPFS_SAVE_FILE, unreadable)
    const database = new YanJuDatabase(`opfs-corrupt-${crypto.randomUUID()}`)
    databases.push(database)
    stores.push(database.persistence)
    await initializeStorage(database)
    expect(mock.files.get('save-recovery.json')).toBe(unreadable)
    expect((await exportSave(database)).archives).toHaveLength(1)
    expect(database.persistence.getStatus().phase).toBe('saved')
  })

  it('工作数据库已有更新时不被旧 OPFS 覆盖，全部表的提交自动同步', async () => {
    mock.files.set(OPFS_SAVE_FILE, JSON.stringify(save))
    const database = new YanJuDatabase(`opfs-cache-${crypto.randomUUID()}`)
    databases.push(database)
    stores.push(database.persistence)
    await database.settings.put(save.settings)
    await database.archives.put({ ...save.archives[0], name: '数据库中的新篇章' })
    await initializeStorage(database)
    await database.archives.update('archive-1', { name: '再次改名', draft: '待发送内容' })
    await database.channels.put(channelFixture)
    await database.messages.bulkPut(save.messages)
    await vi.waitFor(async () => {
      const saved = (await database.persistence.read()) as SaveFile
      expect(saved.archives[0].name).toBe('再次改名')
      expect(saved.archives[0].draft).toBe('待发送内容')
      expect(saved.messages).toEqual(save.messages)
      expect(saved.channels[0]).toEqual(channelFixture)
    })
    await database.archives.delete('archive-1')
    await database.persistence.flush()
    expect(((await database.persistence.read()) as SaveFile).archives).toHaveLength(0)
  })
})
