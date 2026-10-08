import * as React from 'react'
import { cn } from '@/lib/utils'

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-touch w-full min-w-0 rounded-lg border-(length:--border-width) border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-(length:--ring-width) focus-visible:ring-focus-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input-hover disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-(length:--ring-width) aria-invalid:ring-destructive-soft md:text-base dark:bg-input-subtle dark:disabled:bg-input-strong dark:aria-invalid:border-destructive-border dark:aria-invalid:ring-destructive-ring',
        className,
      )}
      {...props}
    />
  )
}

export { Input }
