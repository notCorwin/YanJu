import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import type { ReactNode } from 'react'

/** Page and modal presentations share the same editors and validation. */
export function ManagementSurface({
  page = false,
  open,
  onClose,
  title,
  description,
  step,
  onContinue,
  continueDisabled,
  children,
}: {
  page?: boolean
  open: boolean
  onClose: () => void
  title: string
  description: string
  step: 'channels' | 'persona'
  onContinue?: () => void
  continueDisabled?: boolean
  children: ReactNode
}) {
  if (page)
    return (
      <section
        aria-label={title}
        className="mx-auto flex min-h-0 w-full dialog-wide-width flex-1 flex-col gap-4 compact-height:gap-2"
      >
        <div className="flex shrink-0 flex-col items-center gap-2 text-center compact-height:hidden">
          <p className="font-mono text-xs tracking-cover text-primary">
            {step === 'channels' ? 'STEP 01 · CONNECTION' : 'STEP 02 · PERSONA'}
          </p>
          <h1 className="font-serif text-xl italic">
            {step === 'channels' ? 'Interface Setup' : 'Your Masks'}
          </h1>
          <p className="text-sm text-muted-foreground">{description}</p>
          <div aria-hidden="true" className="editorial-line w-16" />
        </div>
        {children}
        <div className="flex shrink-0 items-center justify-between gap-2 border-t-(length:--border-width) pt-3">
          <Button variant="ghost" onClick={onClose}>
            <ArrowLeft data-icon="inline-start" />
            返回首页
          </Button>
          <Button onClick={onContinue} disabled={continueDisabled}>
            {step === 'channels' ? '继续设置人设' : '进入聊天'}
            <ArrowRight data-icon="inline-end" />
          </Button>
        </div>
      </section>
    )
  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent size="wide" className="editor-height overflow-hidden compact-height:gap-2">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="compact-height:hidden">{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  )
}
