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
import { replaceBackground } from '@/lib/background-storage'
import type { Notify } from '@/lib/notify'
import { friendlyError } from '@/lib/provider'
import { db } from '@/lib/storage'
import { type Settings } from '@/lib/types'
import { useRef, useState } from 'react'

export function AppearanceNumberField({
  label,
  value,
  max,
  onChange,
}: {
  label: string
  value: number
  max: number
  onChange: (value: number) => void
}) {
  const id = label === '聊天字号' ? 'font-chat' : 'font-ui'
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label} · 像素</FieldLabel>
      <Input
        id={id}
        name={id}
        type="number"
        min={12}
        max={max}
        defaultValue={value}
        onChange={(e) => {
          const n = e.target.valueAsNumber
          if (Number.isFinite(n) && n >= 12 && n <= max) onChange(n)
        }}
        onBlur={(e) => {
          const n = e.target.valueAsNumber
          const next = Number.isFinite(n) ? Math.min(max, Math.max(12, n)) : value
          e.target.value = String(next)
          onChange(next)
        }}
      />
      <FieldDescription>可选 12–{max}，更改即时预览并自动保存。</FieldDescription>
    </Field>
  )
}

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
  const update = (key: keyof Settings, value: string | number) =>
    void db.settings.update('app', { [key]: value }).catch((e) => notify(friendlyError(e), true))
  const [savingBackground, setSavingBackground] = useState(false)
  const saving = useRef(false)
  const saveBackground = async (file?: File) => {
    if (saving.current) return
    saving.current = true
    setSavingBackground(true)
    try {
      await replaceBackground(db, file)
    } catch (error) {
      notify(friendlyError(error), true)
    } finally {
      saving.current = false
      setSavingBackground(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>外观设置</DialogTitle>
          <DialogDescription>调整阅读字号、界面字体与背景。更改会自动保存。</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <AppearanceNumberField
            label="聊天字号"
            value={settings.fontChat}
            max={24}
            onChange={(value) => update('fontChat', value)}
          />
          <AppearanceNumberField
            label="界面字号"
            value={settings.fontUi}
            max={18}
            onChange={(value) => update('fontUi', value)}
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
              disabled={savingBackground}
              aria-busy={savingBackground}
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) void saveBackground(file)
              }}
            />
            <FieldDescription role={savingBackground ? 'status' : undefined}>
              {savingBackground ? '正在保存背景图片…' : '保存到当前浏览器，导出存档时一并保存。'}
            </FieldDescription>
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
        <Button
          variant="outline"
          disabled={!settings.bgImage || savingBackground}
          aria-busy={savingBackground}
          onClick={() => void saveBackground()}
        >
          移除背景
        </Button>
      </DialogContent>
    </Dialog>
  )
}
