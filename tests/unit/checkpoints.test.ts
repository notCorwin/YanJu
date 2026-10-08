import { afterEach, describe, expect, it, vi } from 'vitest'
import { importCheckpoint, readCheckpoint, restoreCheckpoint } from '../../src/lib/checkpoints'
import { db } from '../../src/lib/storage'
import { defaults } from '../../src/lib/types'
import { channelFixture } from '../fixtures'

const checkpoint = {
  format: 'yanju-checkpoint-v1',
  id: '95054a98-c8e5-4a55-9a67-7eed591a02bc',
  name: '阅读进度',
  createdAt: 1,
  data: {
    version: 3,
    exportedAt: new Date().toISOString(),
    archives: [],
    messages: [],
    channels: [channelFixture],
    masks: [],
    settings: defaults,
    storyStates: [],
    storyEvents: [],
    tasks: [],
    requests: [],
  },
}

const previous = Object.getOwnPropertyDescriptor(navigator, 'storage')
afterEach(() => {
  if (previous) Object.defineProperty(navigator, 'storage', previous)
  else Reflect.deleteProperty(navigator, 'storage')
})

describe('Checkpoint 校验与写入失败', () => {
  it('工作资料恢复成功后，自动存档写入失败仍返回恢复结果以重新载入界面', async () => {
    const dir = {
      getDirectoryHandle: async () => dir,
      getFileHandle: async () => ({
        getFile: async () => ({ text: async () => JSON.stringify(checkpoint) }),
      }),
    }
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { getDirectory: async () => dir },
    })
    vi.spyOn(db.persistence, 'flush').mockResolvedValue({
      phase: 'error',
      persistent: false,
      error: '写入失败',
    })
    const restored = await restoreCheckpoint(checkpoint.id)
    expect(restored.persistence).toMatchObject({ phase: 'error', error: '写入失败' })
    expect(restored.data.channels[0].capability).toBeUndefined()
    expect(await db.channels.get(channelFixture.id)).toEqual(restored.data.channels[0])
  })
  it('损坏的存档在创建 OPFS 文件前被拒绝，保留工作资料', async () => {
    const getDirectory = vi.fn()
    Object.defineProperty(navigator, 'storage', { configurable: true, value: { getDirectory } })
    await db.channels.put(channelFixture)
    await expect(
      importCheckpoint({
        ...checkpoint,
        data: { ...checkpoint.data, channels: [{ apiKey: 'incomplete' }] },
      }),
    ).rejects.toThrow()
    expect(getDirectory).not.toHaveBeenCalled()
    expect(await db.channels.get(channelFixture.id)).toEqual(channelFixture)
  })

  it.each(['open', 'write', 'close'])(
    '%s 失败时移除未完成快照，原 Checkpoint 和工作资料保留',
    async (failure) => {
      const existing = 'original.json'
      const files = new Map([[existing, JSON.stringify(checkpoint)]])
      const error = new DOMException('存储空间不足', 'QuotaExceededError')
      const abort = vi.fn(async () => undefined)
      const removeEntry = vi.fn(async (name: string) => {
        files.delete(name)
      })
      const dir = {
        getDirectoryHandle: async () => dir,
        removeEntry,
        getFileHandle: async (name: string) => {
          files.set(name, '')
          return {
            createWritable: async () => {
              if (failure === 'open') throw error
              return {
                write: async () => {
                  if (failure === 'write') throw error
                },
                close: async () => {
                  if (failure === 'close') throw error
                },
                abort,
              }
            },
          }
        },
      }
      Object.defineProperty(navigator, 'storage', {
        configurable: true,
        value: { getDirectory: async () => dir },
      })
      await db.channels.put(channelFixture)
      await expect(importCheckpoint(checkpoint)).rejects.toThrow('存储空间不足')
      expect([...files.keys()]).toEqual([existing])
      expect(removeEntry).toHaveBeenCalledOnce()
      expect(abort).toHaveBeenCalledTimes(failure === 'open' ? 0 : 1)
      expect(await db.channels.get(channelFixture.id)).toEqual(channelFixture)
    },
  )

  it('拒绝路径或文件 ID 注入', async () => {
    const getDirectory = vi.fn(async () => ({
      getDirectoryHandle: async () => ({
        getDirectoryHandle: async () => ({ getFileHandle: vi.fn() }),
      }),
    }))
    Object.defineProperty(navigator, 'storage', { configurable: true, value: { getDirectory } })
    await expect(readCheckpoint('../save')).rejects.toThrow()
  })
})
