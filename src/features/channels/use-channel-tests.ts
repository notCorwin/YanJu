import { channelFingerprint } from '@/lib/channels'
import { friendlyError, testChannel } from '@/lib/provider'
import { commitChannelCapability, db } from '@/lib/storage'
import type { Channel, ChannelCapability, Notify } from '@/lib/types'
import { useEffect, useRef, useState } from 'react'

export function useChannelTests(channels: Channel[], notify: Notify) {
  const [testingAll, setTestingAll] = useState(false)
  const [progress, setProgress] = useState('')
  const controller = useRef<AbortController | null>(null)
  const testAll = async () => {
    setTestingAll(true)
    controller.current = new AbortController()
    let discarded = 0
    try {
      for (const snapshot of channels) {
        if (controller.current.signal.aborted) break
        const channel = await db.channels.get(snapshot.id)
        if (!channel) continue
        let capability: ChannelCapability
        try {
          capability = await testChannel(channel, controller.current.signal, undefined, (detail) =>
            setProgress(`${channel.name}：${detail}`),
          )
        } catch (e) {
          if (controller.current.signal.aborted) break
          capability = {
            fingerprint: channelFingerprint(channel),
            testedAt: Date.now(),
            ok: false,
            error: friendlyError(e),
          }
        }
        if (!(await commitChannelCapability(channel, capability))) discarded++
      }
      notify(
        discarded
          ? `渠道测试已结束；${discarded} 个渠道配置已变更或删除，旧测试结果未保存。请重新测试。`
          : '渠道测试已结束，结果显示在各渠道配置中。',
      )
    } catch (e) {
      notify(friendlyError(e), true)
    } finally {
      setTestingAll(false)
      setProgress('')
    }
  }
  useEffect(() => () => controller.current?.abort(), [])
  return { testingAll, progress, testAll, cancel: () => controller.current?.abort() }
}
