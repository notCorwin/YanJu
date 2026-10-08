import { friendlyError } from '@/lib/provider'
import { removePersona as deletePersona, savePersona } from '@/lib/storage'
import type { Notify, Persona } from '@/lib/types'
import { useState } from 'react'

export function usePersonaEditor(persona: Persona, notify: Notify) {
  const [draft, setDraft] = useState(persona)
  const [remove, setRemove] = useState(false)
  const update = (key: keyof Persona, value: string) => setDraft((d) => ({ ...d, [key]: value }))
  const save = async (use = false) => {
    if (!draft.name.trim()) {
      notify('姓名不能为空。', true)
      return
    }
    try {
      await savePersona(draft, use)
      notify(use ? '当前人设已更新。' : '人设已保存。')
    } catch (e) {
      notify(friendlyError(e), true)
    }
  }
  const removePersona = () => deletePersona(persona.id)
  return { draft, remove, setRemove, update, save, removePersona }
}
