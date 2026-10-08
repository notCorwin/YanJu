import { Toaster as Sonner, type ToasterProps } from 'sonner'
import {
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
  Loader2Icon,
} from 'lucide-react'
import { buttonVariants } from './button'
import { cn } from '@/lib/utils'

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      visibleToasts={1}
      className="toaster group pointer-events-none"
      offset={{ top: 'calc(var(--space-unit) * 20)', right: 'calc(var(--space-unit) * 4)' }}
      mobileOffset={{
        top: 'calc(var(--touch-size) * 2 + var(--space-unit) * 8)',
        left: 'calc(var(--space-unit) * 4)',
        right: 'calc(var(--space-unit) * 4)',
      }}
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)',
          '--width': 'var(--panel-width)',
          '--gap': 'calc(var(--space-unit) * 3)',
        } as React.CSSProperties
      }
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            'pointer-events-none flex w-full items-start gap-3 rounded-lg border-(length:--border-width) border-border bg-popover p-4 text-ui font-chat text-popover-foreground shadow-lg data-[type=error]:text-destructive',
          title: 'wrap-break-word',
          description: 'text-sm text-muted-foreground',
          closeButton: cn(
            buttonVariants({ variant: 'ghost', size: 'icon-sm' }),
            'pointer-events-auto',
          ),
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
