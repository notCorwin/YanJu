import 'fake-indexeddb/auto'
import { afterEach } from 'vitest'
import { db } from '../../src/lib/db'

afterEach(async () => {
  await Promise.all([
    db.archives.clear(),
    db.messages.clear(),
    db.channels.clear(),
    db.personas.clear(),
    db.settings.clear(),
    db.storyStates.clear(),
    db.storyEvents.clear(),
    db.tasks.clear(),
    db.requests.clear(),
  ])
  localStorage.clear()
})
