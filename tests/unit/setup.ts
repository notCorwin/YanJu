import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeEach, vi } from 'vitest'
import { db } from '../../src/lib/db'
import { files } from '../../src/lib/file-storage'
import type { MemoryFiles } from '../memory-files'

vi.mock('../../src/lib/file-storage', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/lib/file-storage')>()
  const { MemoryFiles } = await import('../memory-files')
  return { ...original, files: new MemoryFiles() }
})

beforeEach(async () => {
  await db.configuration.open()
  ;(files as MemoryFiles).enabled = true
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all([db.settings.clear(), db.channels.clear(), db.personas.clear()])
  ;(files as MemoryFiles).data.clear()
  localStorage.clear()
})

afterAll(() => db.close())
