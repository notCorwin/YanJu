import * as React from 'react'
import { cn } from '@/lib/utils'

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex field-sizing-content min-h-16 w-full rounded-lg border-(length:--border-width) border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-(length:--ring-width) focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:bg-input-hover disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-(length:--ring-width) aria-invalid:ring-destructive-soft md:text-base dark:bg-input-subtle dark:disabled:bg-input-strong dark:aria-invalid:border-destructive-border dark:aria-invalid:ring-destructive-ring',
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }
