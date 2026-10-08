import { friendlyError } from '@/lib/provider'
import { createChannel, updateSettings } from '@/lib/storage'
import type { Channel, Notify, Settings } from '@/lib/types'
import { useEffect, useState } from 'react'

export function useChannels(channels: Channel[], settings: Settings, notify: Notify) {
  const [selectedId, setSelectedId] = useState('')
  const [creating, setCreating] = useState(false)
  const [createdId, setCreatedId] = useState('')
  useEffect(() => {
    if (createdId && channels.some((item) => item.id === createdId)) {
      setSelectedId(createdId)
      setCreatedId('')
      setCreating(false)
    }
  }, [createdId, channels])
  const selected =
    channels.find((c) => c.id === selectedId) ??
    channels.find((c) => c.id === settings.activeChannelId) ??
    channels[0]
  const add = async () => {
    setCreating(true)
    try {
      setCreatedId((await createChannel()).id)
    } catch (e) {
      setCreating(false)
      notify(friendlyError(e), true)
    }
  }
  const activateSelected = async () => {
    if (!selected) return
    try {
      await updateSettings({ activeChannelId: selected.id })
      notify(`已切换到 ${selected.name}`)
    } catch (e) {
      notify(friendlyError(e), true)
    }
  }
  return { selected, setSelectedId, add, activateSelected, creating }
}
