import { db } from '@/lib/storage/database'
import type { RequestRecord } from '@/lib/types'

export async function saveRequestRecord(request: RequestRecord) {
  await db.transaction('rw', [...db.gameTables, db.archives, db.requests], async () => {
    const available = request.archiveId === null || (await db.archives.get(request.archiveId))
    await db.requests.put({ ...request, archiveId: available ? request.archiveId : null })
  })
}
