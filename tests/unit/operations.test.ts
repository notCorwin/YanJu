import Dexie from 'dexie'
import { describe, expect, it, vi } from 'vitest'
import { db, exportSave, initializeStorage, YanJuDatabase, importSave } from '../../src/lib/db'
import { acquireArchiveOperation } from '../../src/lib/operations'
import { defaults } from '../../src/lib/types'
import { messageFixture } from '../fixtures'

async function seed() {
  await db.settings.put(defaults)
  await db.archives.put({
    id: 'archive-1',
    name: '篇章',
    createdAt: 1,
    updatedAt: 1,
    revision: 0,
    draft: '',
  })
}
describe('跨窗口会话操作', () => {
  it('两个数据库连接只能有一个操作持有者，释放后可继续', async () => {
    await seed()
    const other = new YanJuDatabase(db.name)
    const first = await acquireArchiveOperation('archive-1')
    try {
      await expect(acquireArchiveOperation('archive-1', other)).rejects.toThrow(/另一个窗口/)
      await first.release()
      const next = await acquireArchiveOperation('archive-1', other)
      await next.release()
      expect(await db.operations.count()).toBe(0)
    } finally {
      await first.release()
      other.close()
    }
  })
  it('操作期间禁止全量导入，现有资料保持不变', async () => {
    await seed()
    const operation = await acquireArchiveOperation('archive-1')
    try {
      await expect(importSave({ version: 2, archives: [], messages: [] })).rejects.toThrow(
        /另一个窗口/,
      )
      expect((await db.archives.get('archive-1'))?.name).toBe('篇章')
    } finally {
      await operation.release()
    }
  })
  it.each(['replace', 'merge'] as const)(
    '%s 导入事务期间新发起的操作不能排队写入恢复后的篇章',
    async (mode) => {
      await seed()
      const backup = await exportSave()
      const other = new YanJuDatabase(db.name)
      const entered = Promise.withResolvers<void>()
      const resume = Promise.withResolvers<void>()
      const write = db.messages.bulkPut.bind(db.messages)
      const paused = vi.spyOn(db.messages, 'bulkPut').mockImplementationOnce(async (...args) => {
        const result = await write(...args)
        entered.resolve()
        await Dexie.waitFor(resume.promise)
        return result
      })
      const importing = importSave(backup, db, false, mode)
      try {
        await entered.promise
        // The old lease acquisition queued behind this write transaction and appended afterward.
        const pending = acquireArchiveOperation('archive-1', other).then(async (lease) => {
          try {
            await other.messages.put(messageFixture('stale-send', 'user', '旧窗口的发送', 1))
          } finally {
            await lease.release()
          }
        })
        const rejected = expect(pending).rejects.toThrow(/正在导入存档/)
        resume.resolve()
        await importing
        await rejected
        expect(await db.messages.get('stale-send')).toBeUndefined()
        const next = await acquireArchiveOperation('archive-1', other)
        await next.release()
        expect(await db.operations.count()).toBe(0)
      } finally {
        resume.resolve()
        await importing
        paused.mockRestore()
        other.close()
      }
    },
  )
  it('导入写入失败时回滚资料并释放全局租约', async () => {
    await seed()
    const backup = await exportSave()
    const failed = vi.spyOn(db.messages, 'bulkPut').mockRejectedValueOnce(new Error('写入失败'))
    try {
      await expect(importSave(backup)).rejects.toThrow('写入失败')
      expect((await db.archives.get('archive-1'))?.name).toBe('篇章')
      expect(await db.operations.count()).toBe(0)
      const next = await acquireArchiveOperation('archive-1')
      await next.release()
    } finally {
      failed.mockRestore()
    }
  })
  it('第二个窗口启动时保留正在生成的部分消息', async () => {
    await seed()
    const operation = await acquireArchiveOperation('archive-1')
    const other = new YanJuDatabase(db.name)
    try {
      await db.messages.put({ ...messageFixture('partial', 'assistant', '', 0), status: 'partial' })
      await initializeStorage(other)
      expect((await db.messages.get('partial'))?.status).toBe('partial')
    } finally {
      await operation.release()
      other.persistence.stop()
      other.close()
    }
  })
  it('过期持有者释放时不能删除新窗口的操作', async () => {
    await seed()
    const first = await acquireArchiveOperation('archive-1')
    await db.operations.update('archive-1', { expiresAt: 0 })
    const next = await acquireArchiveOperation('archive-1')
    try {
      await first.release()
      expect((await db.operations.get('archive-1'))?.owner).toBe(next.owner)
    } finally {
      await first.release()
      await next.release()
    }
  })
})
