import { channelFingerprint, withCapability } from '@/lib/channels'
import { db } from '@/lib/storage/database'
import { type Channel, type ChannelCapability } from '@/lib/types'

export async function commitChannelCapability(
  tested: Channel,
  capability: ChannelCapability,
  database = db,
): Promise<Channel | undefined> {
  return database.transaction('rw', database.channels, async () => {
    const current = await database.channels.get(tested.id)
    if (!current || channelFingerprint(current) !== channelFingerprint(tested)) return undefined
    const next = withCapability(current, capability)
    await database.channels.update(current.id, {
      capability: next.capability,
      calibration: next.calibration,
    })
    return next
  })
}
