import { FormField } from '@/components/shared'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { type Notify, type Settings } from '@/lib/types'
import { useAppearance } from './use-appearance'

export function AppearanceDialog({
  open,
  onClose,
  settings,
  notify,
}: {
  open: boolean
  onClose: () => void
  settings: Settings
  notify: Notify
}) {
  const { update, upload } = useAppearance(notify)
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>外观设置</DialogTitle>
          <DialogDescription>
            字体、背景和透明度会应用到整个界面的共享设计 Token。
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <FormField
            label="聊天字号"
            type="number"
            min={12}
            max={24}
            value={settings.fontChat}
            onChange={(v) => update('fontChat', Math.min(24, Math.max(12, Number(v))))}
          />
          <FormField
            label="界面字号"
            type="number"
            min={12}
            max={18}
            value={settings.fontUi}
            onChange={(v) => update('fontUi', Math.min(18, Math.max(12, Number(v))))}
          />
          <Field>
            <FieldLabel htmlFor="font-family">字体</FieldLabel>
            <Select value={settings.fontFamily} onValueChange={(v) => update('fontFamily', v)}>
              <SelectTrigger id="font-family" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {[
                    ['Noto Serif SC', '思源宋体'],
                    ['Noto Serif TC', '思源宋体繁体'],
                    ['system-ui', '系统字体'],
                    ['KaiTi', '楷体'],
                  ].map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="background-file">背景图片</FieldLabel>
            <Input
              id="background-file"
              type="file"
              accept="image/*"
              onChange={(e) => void upload(e.target.files?.[0])}
            />
            <FieldDescription>保存到当前浏览器，导出存档时一并保存。</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="background-opacity">背景透明度 · {settings.bgOpacity}%</FieldLabel>
            <Input
              id="background-opacity"
              type="range"
              min={0}
              max={100}
              value={settings.bgOpacity}
              onChange={(e) => update('bgOpacity', Number(e.target.value))}
            />
          </Field>
        </FieldGroup>
        <Button variant="outline" onClick={() => update('bgImage', '')}>
          移除背景
        </Button>
      </DialogContent>
    </Dialog>
  )
}
