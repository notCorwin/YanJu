import { useEffect, useId, useState, type ComponentProps, type ReactNode } from 'react'
import { LoaderCircle } from 'lucide-react'
import { friendlyError } from '@/lib/provider'
import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { Field, FieldLabel, FieldDescription } from './ui/field'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'

export function IconButton({
  label,
  children,
  ...props
}: ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={label} {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
export function FormField({
  label,
  help,
  value,
  onChange,
  multiline,
  ...props
}: {
  label: string
  help?: string
  value: string | number
  onChange: (value: string) => void
  multiline?: boolean
} & Omit<ComponentProps<typeof Input>, 'value' | 'onChange'>) {
  const id = useId()
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {multiline ? (
        <Textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} rows={4} />
      ) : (
        <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} {...props} />
      )}
      {help && <FieldDescription>{help}</FieldDescription>}
    </Field>
  )
}
export function ConfirmDialog({
  title,
  detail,
  open,
  onClose,
  onConfirm,
  destructive = true,
}: {
  title: string
  detail: ReactNode
  open: boolean
  onClose: () => void
  onConfirm: () => Promise<void> | void
  destructive?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (open) setError('')
  }, [open])
  const confirm = async () => {
    if (busy) return
    setBusy(true)
    try {
      await onConfirm()
      onClose()
    } catch (error) {
      setError(friendlyError(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{detail}</DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="wrap-break-word text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            disabled={busy}
            onClick={() => void confirm()}
          >
            {busy && <LoaderCircle data-icon="inline-start" className="animate-spin" />}
            确认
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
export function Prose({ text }: { text?: string }) {
  if (!text) return null
  return (
    <div className="flex flex-col gap-4 whitespace-pre-wrap wrap-break-word text-chat font-chat leading-prose">
      {text
        .split(/\n\s*\n/)
        .filter(Boolean)
        .map((p, i) => (
          <p key={i}>{p}</p>
        ))}
    </div>
  )
}
export function Eyebrow({ children }: { children: ReactNode }) {
  return <span className="text-xs font-mono tracking-editorial text-primary">{children}</span>
}
