import { ConfirmDialog, FormField, IconButton } from '@/components/shared'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { FieldGroup } from '@/components/ui/field'
import { type Notify, type Persona } from '@/lib/types'
import { Trash2 } from 'lucide-react'
import { usePersonaEditor } from './use-persona-editor'

export function PersonaEditor({
  persona,
  active,
  notify,
  disabled,
}: {
  persona: Persona
  active: boolean
  notify: Notify
  disabled: boolean
}) {
  const { draft, remove, setRemove, update, save, removePersona } = usePersonaEditor(
    persona,
    notify,
  )
  return (
    <Card>
      <CardHeader>
        <CardTitle>{draft.name}</CardTitle>
        <CardDescription>
          {active ? '当前人设 · 每轮都会发送给模型' : '保存后可设为当前人设'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <fieldset disabled={disabled} className="flex flex-col gap-5">
          <FieldGroup>
            <FormField label="姓名" value={draft.name} onChange={(v) => update('name', v)} />
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
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void save()}>保存人设</Button>
            <Button variant="secondary" onClick={() => void save(true)}>
              使用此人设
            </Button>
            <IconButton label="删除人设" variant="destructive" onClick={() => setRemove(true)}>
              <Trash2 data-icon="inline-start" />
            </IconButton>
          </div>
        </fieldset>
        <ConfirmDialog
          open={remove}
          onClose={() => setRemove(false)}
          title="删除人设？"
          detail="聊天记录会保留，可以重新创建人设。"
          onConfirm={removePersona}
        />
      </CardContent>
    </Card>
  )
}
