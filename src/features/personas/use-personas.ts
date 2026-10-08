import { friendlyError } from '@/lib/provider'
import { createPersona } from '@/lib/storage'
import type { Notify, Persona, Settings } from '@/lib/types'
import { useEffect, useState } from 'react'

export function usePersonas(personas: Persona[], settings: Settings, notify: Notify) {
  const [id, setId] = useState('')
  const [creating, setCreating] = useState(false)
  const [createdId, setCreatedId] = useState('')
  useEffect(() => {
    if (createdId && personas.some((item) => item.id === createdId)) {
      setId(createdId)
      setCreatedId('')
      setCreating(false)
    }
  }, [createdId, personas])
  const selected =
    personas.find((p) => p.id === id) ??
    personas.find((p) => p.id === settings.activePersonaId) ??
    personas[0]
  const add = async () => {
    setCreating(true)
    try {
      setCreatedId((await createPersona()).id)
    } catch (e) {
      setCreating(false)
      notify(friendlyError(e), true)
    }
  }
  return { selected, setId, add, creating }
}
