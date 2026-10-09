import { Button } from '@/components/ui/button'
import type { CSSProperties } from 'react'

const memories = ['我身上什么味道', '我瞳孔的深度', '我嘴角笑的弧度', '我看你的眼神']

export function NarrativeCover({
  onEnter,
  obscured = false,
}: {
  onEnter: () => void
  obscured?: boolean
}) {
  return (
    <section
      aria-label="宴雎 · 恨海情天"
      data-obscured={obscured}
      className="mx-auto w-full cover-width cover-motion animate-cover-stage text-center leading-cover"
    >
      <div className="mb-8 flex flex-col items-center">
        <h1 className="font-serif text-cover-title font-normal tracking-cover-title italic text-primary">
          Abyss &amp; Desire
        </h1>
        <p className="mt-2 text-cover-copy tracking-cover-subtitle text-foreground-dim">
          恨 海 情 天
        </p>
        <div aria-hidden="true" className="editorial-line mt-4.5 w-15 shadow-line" />
      </div>
      <div className="relative isolate w-full cover-height animate-float">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="cover-glow-top absolute animate-breathe" />
          <div className="cover-glow-bottom absolute animate-breathe-alt" />
          <span className="cover-watermark absolute animate-cover-watermark font-serif italic">
            Yan Ju
          </span>
        </div>
        <div className="relative grid h-full grid-cols-(--cover-columns) items-center px-2 sm:px-4">
          <div className="relative flex min-w-0 flex-col gap-1.75 text-left">
            <span aria-hidden="true" className="cover-rule absolute animate-cover-rule" />
            {memories.map((line, index) => (
              <p
                key={line}
                data-cover-line
                className="cover-memory relative animate-cover-copy pl-3 text-cover-copy leading-heading tracking-memory text-foreground-soft"
                style={{ '--reveal-order': index } as CSSProperties}
              >
                {line}
              </p>
            ))}
            <p
              data-cover-line
              className="mt-1.5 animate-cover-copy pl-3 font-mono text-cover-note tracking-memory text-primary-muted"
              style={{ '--reveal-order': 4 } as CSSProperties}
            >
              DO YOU STILL REMEMBER?
            </p>
          </div>
          <div aria-hidden="true" className="cover-portrait relative animate-cover-portrait p-0.75">
            <div className="relative size-full cover-picture">
              <div className="absolute inset-0 cover-texture" />
            </div>
            <div className="absolute inset-0 cover-glass" />
            <span className="cover-tag absolute font-mono text-foreground-dim">SEQ. 2019</span>
          </div>
          <div className="relative min-w-0 text-right">
            <p
              data-cover-line
              className="mb-2 animate-cover-copy text-cover-main font-normal tracking-cover-main"
              style={{ '--reveal-order': 5 } as CSSProperties}
            >
              <span className="material-text">在這恨海情天裡</span>
            </p>
            <p
              data-cover-line
              className="animate-cover-copy text-cover-copy font-light tracking-cover-caption text-foreground-muted"
              style={{ '--reveal-order': 6 } as CSSProperties}
            >
              哪裡是我們的天上人間
            </p>
            <span
              aria-hidden="true"
              className="cover-cross absolute animate-cover-copy"
              style={{ '--reveal-order': 7 } as CSSProperties}
            />
          </div>
        </div>
      </div>
      <div className="mt-10 flex justify-center">
        <Button size="cover" aria-label="进入聊天" onClick={onEnter}>
          进 入
        </Button>
      </div>
    </section>
  )
}
