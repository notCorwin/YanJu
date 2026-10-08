import { channelFingerprint, withCapability } from '../channels'
import type { Channel, ChannelCapability } from '../types'
import { db } from './database'

/** Probes finish asynchronously; commit only if their request configuration is still current. */
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
