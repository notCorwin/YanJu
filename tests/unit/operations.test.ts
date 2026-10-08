import { describe, expect, it } from 'vitest'
import { db, initializeStorage, YanJuDatabase, importSave } from '../../src/lib/db'
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
