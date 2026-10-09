import 'fake-indexeddb/auto'
import { afterEach, vi } from 'vitest'
import { db } from '../../src/lib/storage'
import { catalogFixture } from '../model-catalog-fixture'

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
