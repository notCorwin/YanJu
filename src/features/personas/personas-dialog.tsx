import { ConfirmDialog } from '@/components/shared'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { PersonaEditor } from '@/features/personas/persona-editor'
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes'
import type { Notify } from '@/lib/notify'
import { friendlyError } from '@/lib/provider'
import { db } from '@/lib/storage'
import { newPersona, type Persona, type Settings } from '@/lib/types'
import { Check, Plus, VenetianMask } from 'lucide-react'
import { useState } from 'react'

export function PersonasDialog({
  open,
  onClose,
  personas,
  settings,
  notify,
  disabled,
}: {
  open: boolean
  onClose: () => void
  personas: Persona[]
  settings: Settings
  notify: Notify
  disabled: boolean
}) {
  const [id, setId] = useState('')
  const [dirty, setDirty] = useState(false)
  const { guard, confirmation } = useUnsavedChanges(dirty)
  const selected =
    personas.find((p) => p.id === id) ??
    personas.find((p) => p.id === settings.activePersonaId) ??
    personas[0]
  return (
    <Dialog open={open} onOpenChange={(v) => !v && guard(onClose)}>
      <DialogContent size="wide" className="editor-height overflow-hidden compact-height:gap-2">
        <DialogHeader>
          <DialogTitle>人设管理</DialogTitle>
          <DialogDescription className="compact-height:hidden">
            你的姓名、身份、喜好与每轮强制指令。
          </DialogDescription>
        </DialogHeader>
        <Button
          className="w-fit"
          disabled={disabled}
          onClick={() =>
            guard(() => {
              const p = newPersona()
              void db.personas
                .add(p)
                .then(() => setId(p.id))
                .catch((e) => notify(friendlyError(e), true))
            })
          }
        >
          <Plus />
          新建人设
        </Button>
        <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-4 md:grid-cols-[1fr_2fr] md:grid-rows-1">
          <nav
            className="flex min-w-0 gap-2 overflow-x-auto pb-1 md:flex-col md:overflow-y-auto"
            aria-label="人设列表"
          >
            {personas.map((p) => (
              <Button
                key={p.id}
                variant={selected?.id === p.id ? 'secondary' : 'ghost'}
                className="min-w-0 justify-start overflow-hidden"
                aria-current={selected?.id === p.id ? 'true' : undefined}
                onClick={() => selected?.id !== p.id && guard(() => setId(p.id))}
              >
                {p.id === settings.activePersonaId && <Check />}
                <span className="truncate">{p.name}</span>
              </Button>
            ))}
          </nav>
          {!selected && (
            <Empty className="md:col-span-2">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <VenetianMask />
                </EmptyMedia>
                <EmptyTitle>你想成为谁？</EmptyTitle>
                <EmptyDescription>
                  点击「新建人设」，为故事中的自己填写姓名、身份和喜好。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          {selected && (
            <PersonaEditor
              key={selected.id}
              persona={selected}
              onDirtyChange={setDirty}
              active={settings.activePersonaId === selected.id}
              notify={notify}
              disabled={disabled}
            />
          )}
        </div>
      </DialogContent>
      <ConfirmDialog
        {...confirmation}
        title="放弃未保存的修改？"
        detail="修改还没有保存。可以取消返回编辑，或放弃修改后继续。"
        confirmLabel="放弃修改"
        destructive={false}
      />
    </Dialog>
  )
}
