import { afterEach, describe, expect, it, vi } from 'vitest'
import { exportSave, importSave, YanJuDatabase } from '../../src/lib/db'
import { readBackground, replaceBackground } from '../../src/lib/background-storage'
import {
  blobToDataUrl,
  dataUrlToImage,
  OpfsFileStorage,
  storageLockName,
} from '../../src/lib/file-storage'
import { MemoryFiles } from '../memory-files'
import { messageFixture, pngDataUrl, saveFixture } from '../fixtures'

const databases: YanJuDatabase[] = []
function store(storage = new MemoryFiles()) {
  const name = `opfs-test-${crypto.randomUUID()}`
  const database = new YanJuDatabase(storage, name, name)
  databases.push(database)
  return { database, storage }
}
const image = () => new File([dataUrlToImage(pngDataUrl)!], 'background.png', { type: 'image/png' })
const snapshot = async (database: YanJuDatabase) => {
  const { exportedAt, ...data } = await exportSave(database)
  expect(exportedAt).toBeTruthy()
  return data
}
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const database of databases.splice(0)) {
    database.close()
    await database.configuration.delete()
  }
})

describe('OPFS 文件提交与完整存档（内存文件模拟）', () => {
  it('存档与消息只写入文件，配置保留在 IndexedDB，背景原字节往返', async () => {
    const { database, storage } = store()
    await importSave(
      { ...saveFixture, settings: { ...saveFixture.settings, bgImage: pngDataUrl } },
      database,
    )
    expect(database.configuration.tables.map((table) => table.name).sort()).toEqual([
      'channels',
      'personas',
      'settings',
    ])
    const settings = (await database.settings.get('app'))!
    expect(settings.bgImage).toBe('')
    expect(settings.bgImageRef?.mimeType).toBe('image/png')
    expect(settings.archiveCatalogId).toBeTruthy()
    expect(
      await blobToDataUrl(await readBackground(settings.bgImageRef!, storage, database.root)),
    ).toBe(pngDataUrl)
    const paths = [...storage.data.keys()]
    expect(paths.filter((path) => path.includes('/archives/'))).toHaveLength(2)
    expect(paths.filter((path) => path.includes('/catalogs/'))).toHaveLength(1)
    const catalog = JSON.parse(
      await (
        await storage.read(`${database.root}/catalogs/${settings.archiveCatalogId}.json`)
      ).text(),
    )
    expect(catalog.records.channels).toEqual([])
    expect(catalog.records.settings).toEqual([])
    const exported = await snapshot(database)
    expect(exported.settings.bgImage).toBe(pngDataUrl)
    expect(exported.settings).not.toHaveProperty('bgImageRef')
    expect(exported.settings).not.toHaveProperty('archiveCatalogId')
    expect(exported.channels).toEqual(saveFixture.channels)
    expect(exported.messages).toEqual(saveFixture.messages)
    const fresh = store()
    await importSave(exported, fresh.database)
    expect(await snapshot(fresh.database)).toEqual(exported)
    database.close()
    await database.open()
    expect(await snapshot(database)).toEqual(exported)
  })

  it.each(['backgrounds', 'archives', 'catalogs'])(
    '%s 写入失败时保留全部原资料与原文件',
    async (directory) => {
      const { database, storage } = store()
      await importSave(
        { ...saveFixture, settings: { ...saveFixture.settings, bgImage: pngDataUrl } },
        database,
      )
      const before = await snapshot(database)
      const paths = [...storage.data.keys()].sort()
      const write = storage.write.bind(storage)
      vi.spyOn(storage, 'write').mockImplementation(async (path, data) => {
        if (path.includes(`/${directory}/`)) {
          // Simulate a file created before its write/close fails.
          await write(path, 'unfinished')
          throw new Error('disk full')
        }
        await write(path, data)
      })
      await expect(
        importSave(
          {
            ...before,
            archives: [{ ...before.archives[0], name: '新资料' }],
            messages: before.messages.filter((m) => m.archiveId === 'archive-1'),
          },
          database,
        ),
      ).rejects.toThrow('disk full')
      expect(await snapshot(database)).toEqual(before)
      expect([...storage.data.keys()].sort()).toEqual(paths)
    },
  )

  it('IndexedDB 提交失败时回滚渠道、人设、设置与所有文件引用', async () => {
    const { database, storage } = store()
    await importSave(saveFixture, database)
    const before = await snapshot(database)
    const paths = [...storage.data.keys()].sort()
    vi.spyOn(database.settings, 'put').mockRejectedValue(new Error('database commit failed'))
    await expect(
      importSave(
        {
          ...saveFixture,
          channels: [],
          masks: [],
          settings: { ...saveFixture.settings, bgImage: pngDataUrl },
        },
        database,
      ),
    ).rejects.toThrow('database commit failed')
    expect(await snapshot(database)).toEqual(before)
    expect([...storage.data.keys()].sort()).toEqual(paths)
  })

  it('背景上传、替换与删除只切换引用，数据库失败保留旧图', async () => {
    const { database, storage } = store()
    await importSave(saveFixture, database)
    await replaceBackground(database, image())
    const first = (await database.settings.get('app'))!.bgImageRef!
    const update = vi
      .spyOn(database.settings, 'update')
      .mockRejectedValueOnce(new Error('commit failed'))
    await expect(replaceBackground(database, image())).rejects.toThrow('commit failed')
    expect((await database.settings.get('app'))!.bgImageRef).toEqual(first)
    expect(await storage.list(`${database.root}/backgrounds`)).toEqual([first.id])
    update.mockRestore()
    await replaceBackground(database, image())
    const second = (await database.settings.get('app'))!.bgImageRef!
    expect(second.id).not.toBe(first.id)
    expect(await storage.list(`${database.root}/backgrounds`)).toEqual([second.id])
    await replaceBackground(database, undefined)
    expect((await database.settings.get('app'))!.bgImageRef).toBeUndefined()
    expect(await storage.list(`${database.root}/backgrounds`)).toEqual([])
  })

  it('文件写入期间修改普通设置，提交图片引用不会覆盖新设置', async () => {
    const { database, storage } = store()
    await importSave(saveFixture, database)
    const write = storage.write.bind(storage)
    vi.spyOn(storage, 'write').mockImplementation(async (path, data) => {
      if (path.includes('/backgrounds/'))
        await database.settings.update('app', { fontChat: 20, bgOpacity: 42 })
      await write(path, data)
    })
    await replaceBackground(database, image())
    expect(await database.settings.get('app')).toMatchObject({
      fontChat: 20,
      bgOpacity: 42,
      bgImage: '',
    })
    expect((await snapshot(database)).settings.bgImage).toBe(pngDataUrl)
  })

  it('清理失败不撤销提交，下次清理删除遗留文件', async () => {
    const { database, storage } = store()
    await importSave(saveFixture, database)
    await replaceBackground(database, image())
    const old = (await database.settings.get('app'))!.bgImageRef!
    const remove = vi.spyOn(storage, 'remove').mockRejectedValue(new Error('cleanup failed'))
    await replaceBackground(database, image())
    const current = (await database.settings.get('app'))!.bgImageRef!
    expect(current.id).not.toBe(old.id)
    expect(await snapshot(database)).toHaveProperty('settings.bgImage', pngDataUrl)
    expect(await storage.list(`${database.root}/backgrounds`)).toHaveLength(2)
    await storage.write(`${database.root}/archives/orphan`, 'unfinished')
    await database.cleanup()
    remove.mockRestore()
    await database.cleanup()
    expect(await storage.list(`${database.root}/backgrounds`)).toEqual([current.id])
    expect(await storage.list(`${database.root}/archives`)).toHaveLength(2)
  })

  it('已引用图片缺失时保留引用且完整导出失败，完整导入可修复损坏目录', async () => {
    const { database, storage } = store()
    await importSave(
      { ...saveFixture, settings: { ...saveFixture.settings, bgImage: pngDataUrl } },
      database,
    )
    const settings = (await database.settings.get('app'))!
    await storage.remove(`${database.root}/backgrounds/${settings.bgImageRef!.id}`)
    await expect(exportSave(database)).rejects.toThrow(/背景图片读取失败/)
    expect((await database.settings.get('app'))!.bgImageRef).toEqual(settings.bgImageRef)
    await storage.write(`${database.root}/catalogs/${settings.archiveCatalogId}.json`, '{broken')
    await expect(database.open()).rejects.toThrow(/存档目录无法读取/)
    await importSave(saveFixture, database)
    await database.open()
    expect((await snapshot(database)).messages).toEqual(saveFixture.messages)
  })

  it('OPFS 不可用时拒绝存档操作，上传失败也不向 IndexedDB 保存 Data URL', async () => {
    const { database, storage } = store()
    await importSave(saveFixture, database)
    const original = await snapshot(database)
    storage.enabled = false
    await expect(database.open()).rejects.toThrow(/OPFS/)
    await expect(importSave(saveFixture, database)).rejects.toThrow(/OPFS/)
    storage.enabled = true
    vi.spyOn(storage, 'write').mockRejectedValue(new Error('cannot write'))
    await expect(replaceBackground(database, image())).rejects.toThrow('cannot write')
    expect(await snapshot(database)).toEqual(original)
    expect((await database.settings.get('app'))!.bgImage).toBe('')
  })

  it('非法背景导入不替换原资料，外部 JSON 引用不能进入配置', async () => {
    const { database } = store()
    await importSave(saveFixture, database)
    const original = await snapshot(database)
    await expect(
      importSave({ ...saveFixture, settings: { bgImage: 'data:image/png;base64,%%%' } }, database),
    ).rejects.toThrow(/无法解码/)
    expect(await snapshot(database)).toEqual(original)
    await importSave(
      {
        ...saveFixture,
        settings: {
          ...saveFixture.settings,
          bgImageRef: { id: 'foreign', size: 1, mimeType: 'image/png' },
          archiveCatalogId: 'foreign',
        },
      },
      database,
    )
    expect((await database.settings.get('app'))!.bgImageRef).toBeUndefined()
    expect((await database.settings.get('app'))!.archiveCatalogId).not.toBe('foreign')
  })

  it('两个实例共享 Web Lock，替换和导出得到各自一致的快照', async () => {
    let tail = Promise.resolve<unknown>(undefined)
    const request = vi.fn((_name: string, callback: () => Promise<unknown>) => {
      const result = tail.then(callback)
      tail = result.catch(() => undefined)
      return result
    })
    vi.stubGlobal('navigator', { locks: { request } })
    const { database, storage } = store()
    const other = new YanJuDatabase(storage, database.root, database.configuration.name)
    databases.push(other)
    await importSave(saveFixture, database)
    const [before] = await Promise.all([
      exportSave(other),
      database.mutate(async (tx) => {
        await tx.messages.put(messageFixture('added', 'user', '同时写入', 1))
        await tx.archives.update('archive-1', { draft: '新草稿' })
      }),
      replaceBackground(database, image()),
    ])
    expect(before.messages).toHaveLength(2)
    expect(before.settings.bgImage).toBe('')
    const after = await exportSave(other)
    expect(after.messages).toHaveLength(3)
    expect(after.archives[0].draft).toBe('新草稿')
    expect(after.settings.bgImage).toBe(pngDataUrl)
    expect(request.mock.calls.every(([name]) => name === storageLockName)).toBe(true)
  })

  it('原生写入在关闭失败时中止，错误传回调用者', async () => {
    const abort = vi.fn().mockResolvedValue(undefined)
    const write = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn().mockRejectedValue(new Error('close failed'))
    const handle = { createWritable: vi.fn().mockResolvedValue({ write, close, abort }) }
    const directory = { getFileHandle: vi.fn().mockResolvedValue(handle) }
    vi.stubGlobal('navigator', { storage: { getDirectory: vi.fn().mockResolvedValue(directory) } })
    await expect(new OpfsFileStorage().write('background', image())).rejects.toThrow('close failed')
    expect(write).toHaveBeenCalledOnce()
    expect(abort).toHaveBeenCalledOnce()
  })
})
