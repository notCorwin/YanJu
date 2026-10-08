import { ConfirmDialog, FormField, IconButton } from '@/components/shared'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { FieldGroup } from '@/components/ui/field'
import type { Notify } from '@/lib/notify'
import { friendlyError } from '@/lib/provider'
import { db } from '@/lib/storage'
import { type Persona } from '@/lib/types'
import { LoaderCircle, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

export function PersonaEditor({
  persona,
  active,
  notify,
  disabled,
  onDirtyChange,
}: {
  persona: Persona
  active: boolean
  notify: Notify
  disabled: boolean
  onDirtyChange: (dirty: boolean) => void
}) {
  const [draft, setDraft] = useState(persona)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  const dirty = JSON.stringify(draft) !== JSON.stringify(persona)
  useEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])
  const save = async (usePersona = false) => {
    if (!draft.name.trim()) {
      setError('请输入人设姓名。')
      formRef.current?.querySelector<HTMLInputElement>('input')?.focus()
      return
    }
    setSaving(true)
    try {
      const value = {
        ...draft,
        name: draft.name.trim(),
        gender: draft.gender.trim(),
        identity: draft.identity.trim(),
        prefer: draft.prefer.trim(),
        force: draft.force.trim(),
      }
      await db.personas.put(value)
      if (usePersona) await db.settings.update('app', { activePersonaId: persona.id })
      setDraft(value)
      notify(usePersona ? '当前人设已更新。' : '人设已保存。')
    } catch (e) {
      notify(friendlyError(e), true)
    } finally {
      setSaving(false)
    }
  }
  const [remove, setRemove] = useState(false)
  const update = (key: keyof Persona, value: string) => {
    setError('')
    setDraft((d) => ({ ...d, [key]: value }))
  }
  return (
    <form
      ref={formRef}
      className="flex min-h-0 min-w-0 flex-col"
      onSubmit={(e) => {
        e.preventDefault()
        if (!saving && !disabled) void save()
      }}
    >
      <Card className="min-h-0 flex-1">
        <CardHeader className="compact-height:hidden">
          <CardTitle>{draft.name.trim() || '未命名人设'}</CardTitle>
          <CardDescription>
            {active ? '当前人设 · 每轮都会发送给模型' : '保存后可设为当前人设'}
          </CardDescription>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-4">
          <fieldset disabled={disabled || saving} className="flex flex-col gap-5">
            <FieldGroup>
              <FormField
                name="name"
                error={error}
                label="姓名"
                value={draft.name}
                onChange={(v) => update('name', v)}
              />
              <FormField label="性别" value={draft.gender} onChange={(v) => update('gender', v)} />
              <FormField
                label="身份"
                value={draft.identity}
                onChange={(v) => update('identity', v)}
              />
              <FormField
                label="喜好"
                value={draft.prefer}
                onChange={(v) => update('prefer', v)}
                multiline
              />
              <FormField
                label="强制指令"
                value={draft.force}
                onChange={(v) => update('force', v)}
                multiline
                help="每一轮均注入到角色设定，控制你的人设与叙事规则。"
              />
            </FieldGroup>
          </fieldset>
          <ConfirmDialog
            open={remove}
            onClose={() => setRemove(false)}
            title="删除人设？"
            detail="聊天记录会保留，可以重新创建人设。"
            onConfirm={async () => {
              await db.personas.delete(persona.id)
              const s = await db.settings.get('app')
              if (s?.activePersonaId === persona.id)
                await db.settings.update('app', { activePersonaId: '' })
            }}
          />
        </CardContent>
        <CardFooter className="shrink-0 flex-wrap gap-2">
          <Button type="submit" disabled={disabled || saving}>
            {saving && <LoaderCircle data-icon="inline-start" className="animate-spin" />}保存人设
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={disabled || saving}
            onClick={() => void save(true)}
          >
            使用此人设
          </Button>
          <IconButton
            type="button"
            label="删除人设"
            variant="ghost"
            disabled={disabled || saving}
            onClick={() => setRemove(true)}
          >
            <Trash2 />
          </IconButton>
        </CardFooter>
      </Card>
    </form>
  )
}
