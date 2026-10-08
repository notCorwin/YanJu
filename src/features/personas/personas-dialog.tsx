import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { type Notify, type Persona, type Settings } from '@/lib/types'
import { Check, Plus } from 'lucide-react'
import { usePersonas } from './use-personas'

import { PersonaEditor } from './persona-editor'

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
  const { selected, setId, add, creating } = usePersonas(personas, settings, notify)
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:page-width">
        <DialogHeader>
          <DialogTitle>人设管理</DialogTitle>
          <DialogDescription>你的姓名、身份、喜好与每轮强制指令。</DialogDescription>
        </DialogHeader>
        <Button className="w-fit" disabled={disabled || creating} onClick={() => void add()}>
          <Plus data-icon="inline-start" />
          新建人设
        </Button>
        <div className="grid gap-4 md:grid-cols-[1fr_2fr]">
          <nav className="flex flex-col gap-2" aria-label="人设列表">
            {personas.map((p) => (
              <Button
                key={p.id}
                variant={selected?.id === p.id ? 'secondary' : 'ghost'}
                className="justify-start"
                disabled={creating}
                onClick={() => setId(p.id)}
              >
                {p.id === settings.activePersonaId && <Check data-icon="inline-start" />}
                {p.name}
              </Button>
            ))}
          </nav>
          {selected && (
            <PersonaEditor
              key={selected.id}
              persona={selected}
              active={settings.activePersonaId === selected.id}
              notify={notify}
              disabled={disabled || creating}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
