import { captureGameNode } from '@/lib/game-history'
import { YanJuDatabase } from '@/lib/storage/database'
import { archiveMessages } from '@/lib/storage/messages'
import { rebuildStory } from '@/lib/story'
import { type Archive } from '@/lib/types'

export async function refreshStory(
  database: YanJuDatabase,
  archive: Archive,
  label?: string,
  force = false,
) {
  const projection = rebuildStory(archive, await archiveMessages(archive.id, database))
  await database.storyStates.put(projection.story)
  await database.storyEvents.where('archiveId').equals(archive.id).delete()
  await database.storyEvents.bulkPut(projection.events)
  await captureGameNode(database, archive, label, force)
}
