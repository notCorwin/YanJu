import { friendlyError } from '@/lib/provider'
import { useEffect, useId, useState, type ComponentProps, type ReactNode } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog'
import { Button } from './ui/button'
import { Field, FieldDescription, FieldLabel } from './ui/field'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

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
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (open) setError('')
  }, [open])
  return (
    <AlertDialog open={open} onOpenChange={(v) => !v && !pending && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{detail}</AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>取消</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? 'destructive' : 'default'}
            disabled={pending}
            onClick={(event) => {
              event.preventDefault()
              setPending(true)
              void Promise.resolve()
                .then(onConfirm)
                .then(onClose)
                .catch((e) => setError(friendlyError(e)))
                .finally(() => setPending(false))
            }}
          >
            {pending ? '正在处理…' : '确认'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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
