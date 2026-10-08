import { protocolLabels } from '@/lib/channels'
import { channelIsReady, friendlyError, testChannel, validateChannel } from '@/lib/provider'
import {
  commitChannelCapability,
  db,
  removeChannel as deleteChannel,
  saveChannel,
} from '@/lib/storage'
import type { Channel, Notify } from '@/lib/types'
import { useEffect, useRef, useState } from 'react'

export function useChannelEditor(channel: Channel, notify: Notify) {
  const [draft, setDraft] = useState(channel)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [remove, setRemove] = useState(false)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  const update = (key: keyof Channel, value: string | number | null) =>
    setDraft((d) => ({
      ...d,
      [key]: value,
      capability: key === 'name' ? d.capability : undefined,
      calibration: key === 'name' ? d.calibration : undefined,
    }))
  const save = async () => {
    try {
      validateChannel(draft)
      await saveChannel(draft)
      notify('渠道已保存；通过测试后可用于聊天。')
    } catch (e) {
      notify(friendlyError(e), true)
    }
  }
  const test = async () => {
    controller.current = new AbortController()
    setBusy(true)
    try {
      validateChannel(draft)
      await saveChannel(draft)
      const capability = await testChannel(draft, controller.current.signal, undefined, setProgress)
      const next = await commitChannelCapability(draft, capability)
      if (!next) {
        const current = await db.channels.get(draft.id)
        if (current) setDraft(current)
        notify('渠道配置已在其他窗口变更或删除，旧测试结果未保存。请重新测试。', true)
        return
      }
      setDraft(next)
      notify(
        capability.ok
          ? `渠道测试通过，使用 ${protocolLabels[capability.protocol!]}。`
          : (capability.error ?? '渠道测试未通过。'),
        !capability.ok,
      )
    } catch (e) {
      if (controller.current.signal.aborted) {
        notify(
          channelIsReady(draft)
            ? '渠道测试已取消，原测试结果已保留。'
            : '渠道测试已取消，须完成测试后使用此配置。',
        )
        return
      }
      notify(friendlyError(e), true)
    } finally {
      setBusy(false)
      setProgress('')
    }
  }
  return {
    draft,
    busy,
    progress,
    remove,
    setRemove,
    update,
    save,
    test,
    cancel: () => controller.current?.abort(),
    removeChannel: () => deleteChannel(channel.id),
  }
}
