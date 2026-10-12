import 'fake-indexeddb/auto'
import { afterEach, vi } from 'vitest'
import { db } from '../../src/lib/storage'
import { catalogFixture } from '../model-catalog-fixture'

// Domain tests use browser storage through its public interface; UI runs in Playwright.
const values = new Map<string, string>()
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { userAgent: 'YanJu unit tests', storage: undefined, locks: undefined },
})
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() {
      return values.size
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(String(key)) ?? null,
    setItem: (key: string, value: string) => {
      values.set(String(key), String(value))
    },
    removeItem: (key: string) => {
      values.delete(String(key))
    },
    clear: () => values.clear(),
  } satisfies Storage,
})

vi.mock('../../src/lib/model-catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/model-catalog')>()
  return {
    ...actual,
    loadModelCatalog: vi.fn(async () => actual.parseModelCatalog(catalogFixture())),
  }
})

afterEach(async () => {
  await Promise.all([
    ...db.historyTables.map((table) => table.clear()),
    db.archives.clear(),
    db.messages.clear(),
    db.channels.clear(),
    db.personas.clear(),
    db.settings.clear(),
    db.storyStates.clear(),
    db.storyEvents.clear(),
    db.tasks.clear(),
    db.requests.clear(),
    db.operations.clear(),
    db.persistenceChanges.clear(),
  ])
  localStorage.clear()
})
