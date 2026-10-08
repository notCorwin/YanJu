import { useEffect, useId, useState, type ComponentProps, type ReactNode } from 'react'
import { friendlyError } from '@/lib/provider'
import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { Field, FieldLabel, FieldDescription, FieldError } from './ui/field'
import { LoaderCircle } from 'lucide-react'
import { Input } from './ui/input'
import { InputGroup, InputGroupInput, InputGroupAddon } from './ui/input-group'
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
  error,
  endAddon,
  value,
  onChange,
  multiline,
  ...props
}: {
  label: string
  help?: string
  error?: string
  endAddon?: ReactNode
  value: string | number
  onChange: (value: string) => void
  multiline?: boolean
} & Omit<ComponentProps<typeof Input>, 'value' | 'onChange'>) {
  const generatedId = useId()
  const id = props.id || generatedId
  const describedBy =
    [help && `${id}-help`, error && `${id}-error`].filter(Boolean).join(' ') || undefined
  const Control = endAddon ? InputGroupInput : Input
  const control = (
    <Control
      {...props}
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-invalid={!!error}
      aria-describedby={describedBy}
    />
  )
  return (
    <Field data-invalid={!!error} data-disabled={props.disabled}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {multiline ? (
        <Textarea
          {...(props as ComponentProps<typeof Textarea>)}
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={!!error}
          aria-describedby={describedBy}
          rows={4}
        />
      ) : endAddon ? (
        <InputGroup>
          {control}
          <InputGroupAddon align="inline-end">{endAddon}</InputGroupAddon>
        </InputGroup>
      ) : (
        control
      )}
      {help && <FieldDescription id={`${id}-help`}>{help}</FieldDescription>}
      {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
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
  confirmLabel = '确认',
}: {
  title: string
  detail: ReactNode
  open: boolean
  onClose: () => void
  onConfirm: () => Promise<void> | void
  destructive?: boolean
  confirmLabel?: string
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (open) setError('')
  }, [open])
  const close = () => {
    if (pending) return
    setError('')
    onClose()
  }
  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent
        onInteractOutside={(e) => pending && e.preventDefault()}
        onEscapeKeyDown={(e) => pending && e.preventDefault()}
      >
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
          <Button variant="outline" disabled={pending} onClick={close}>
            取消
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            disabled={pending}
            onClick={async () => {
              if (pending) return
              setPending(true)
              setError('')
              try {
                await onConfirm()
                onClose()
              } catch (e) {
                setError(friendlyError(e))
              } finally {
                setPending(false)
              }
            }}
          >
            {pending && <LoaderCircle data-icon="inline-start" className="animate-spin" />}
            {confirmLabel}
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
export function Eyebrow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span className={`text-xs font-mono tracking-editorial text-primary ${className}`}>
      {children}
    </span>
  )
}
