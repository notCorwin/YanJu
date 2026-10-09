import { Button } from '@/components/ui/button'
import { ArrowRight } from 'lucide-react'

export function NarrativeCover({ onEnter }: { onEnter: () => void }) {
  return (
    <section
      aria-label="宴雎 · 恨海情天"
      className="mx-auto flex w-full cover-width flex-col items-center gap-6 text-center sm:gap-8"
    >
      <div className="flex animate-reveal flex-col items-center gap-2">
        <p className="font-mono text-xs tracking-cover text-muted-foreground">
          A PRIVATE NARRATIVE SPACE
        </p>
        <h1 className="font-serif text-cover-title tracking-cover italic text-primary">
          Abyss &amp; Desire
        </h1>
        <p className="text-sm tracking-cover text-muted-foreground">恨 海 情 天</p>
        <div aria-hidden="true" className="editorial-line mt-2 w-16" />
      </div>
      <div className="relative grid w-full cover-height animate-float grid-cols-[1fr_auto] items-center gap-3 text-left sm:grid-cols-[1fr_auto_1fr] sm:gap-8">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 cover-glow animate-breathe"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-8 text-center font-serif cover-watermark italic"
        >
          Yan Ju
        </span>
        <div className="relative flex animate-reveal stagger-1 flex-col gap-2 border-l-(length:--border-width) border-primary-border pl-3 sm:pl-5">
          <p className="text-sm leading-prose">我身上什么味道</p>
          <p className="text-sm leading-prose">我瞳孔的深度</p>
          <p className="text-sm leading-prose">我嘴角笑的弧度</p>
          <p className="text-sm leading-prose">我看你的眼神</p>
          <p className="mt-2 font-mono text-xs leading-prose text-primary">
            DO YOU STILL REMEMBER?
          </p>
        </div>
        <div aria-hidden="true" className="animate-reveal stagger-2">
          <div className="cover-portrait relative -rotate-2 overflow-hidden border-(length:--border-width) border-border-soft p-1">
            <div className="absolute inset-1 cover-texture" />
            <div className="absolute inset-0 cover-glass" />
            <div className="absolute inset-0 cover-sheen animate-sweep" />
            <span className="absolute bottom-3 inset-x-0 text-center font-mono text-xs tracking-editorial text-primary">
              宴 雎
            </span>
          </div>
        </div>
        <div className="relative col-span-2 flex animate-reveal stagger-3 flex-col items-center gap-2 text-center sm:col-span-1 sm:items-end sm:gap-3 sm:text-right">
          <p className="text-ui leading-prose tracking-editorial">在這恨海情天裡</p>
          <p className="text-sm leading-prose text-muted-foreground">哪裡是我們的天上人間</p>
          <span aria-hidden="true" className="font-mono text-primary">
            ＋
          </span>
        </div>
      </div>
      <div className="flex flex-col items-center gap-4">
        <Button size="lg" className="min-w-44" onClick={onEnter}>
          进入聊天
          <ArrowRight data-icon="inline-end" />
        </Button>
        <p className="animate-reveal stagger-4 text-xs text-muted-foreground">让故事在此刻继续。</p>
      </div>
    </section>
  )
}
