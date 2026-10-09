import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'
import { Slot } from 'radix-ui'

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border-(length:--border-width) border-transparent bg-clip-padding font-mono text-sm font-normal tracking-button whitespace-nowrap transition-[color,background-color,border-color,box-shadow,transform] outline-none select-none focus-visible:border-ring focus-visible:ring-(length:--ring-width) focus-visible:ring-focus-ring active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-(length:--ring-width) aria-invalid:ring-destructive-soft dark:aria-invalid:border-destructive-border dark:aria-invalid:ring-destructive-ring [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          'border-primary-border-strong bg-primary-subtle text-foreground hover:border-primary hover:bg-primary-hover hover:shadow-glow',
        outline:
          'border-border bg-control text-foreground-soft hover:border-primary hover:bg-primary-faint hover:text-foreground hover:shadow-glow aria-expanded:bg-primary-subtle aria-expanded:text-foreground',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-accent aria-expanded:bg-secondary aria-expanded:text-secondary-foreground',
        ghost:
          'text-foreground-muted hover:border-border hover:bg-muted-subtle hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground',
        destructive:
          'bg-destructive-subtle text-destructive hover:bg-destructive-soft focus-visible:border-destructive-ring focus-visible:ring-destructive-soft dark:bg-destructive-soft dark:hover:bg-destructive-hover dark:focus-visible:ring-destructive-ring',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default:
          'h-touch gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        xs: "h-touch gap-1 rounded-md px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-touch gap-1 rounded-md px-2.5 text-sm in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: 'h-12 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        cover:
          'min-h-touch animate-cover-enter px-10 py-3 text-ui tracking-cover-title focus-visible:animation-complete',
        icon: 'size-touch',
        'icon-xs':
          "size-touch rounded-md in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-touch rounded-md in-data-[slot=button-group]:rounded-lg',
        'icon-lg': 'size-12',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  onClick,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : 'button'

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      onClick={(event) => {
        // Safari does not focus buttons on pointer activation. Keep dialog return
        // focus and keyboard continuation consistent with the other browsers.
        if (!event.defaultPrevented && event.button === 0 && !props.disabled)
          event.currentTarget.focus({ preventScroll: true })
        onClick?.(event)
      }}
      {...props}
    />
  )
}

export { Button, buttonVariants }
