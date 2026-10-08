import { Eyebrow, Prose } from '@/components/shared'
import { AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import type { NarrativeReply } from '@/lib/schemas'
import type { DeepPartial } from 'ai'

export function DiaryPanel({ diary }: { diary: DeepPartial<NarrativeReply['diary']> | undefined }) {
  if (!diary) return null
  return (
    <AccordionItem value="diary">
      <AccordionTrigger>
        <span className="flex flex-col gap-1">
          <Eyebrow>DIARY / COUNTDOWN</Eyebrow>
          <span>宴雎 · 日记</span>
        </span>
      </AccordionTrigger>
      <AccordionContent>
        <div className="flex flex-col gap-4 py-3">
          <Prose text={diary.text} />
          <p className="text-ui text-primary">距求婚还有 {diary.countdownDays ?? '…'} 天</p>
          <p className="text-ui text-muted-foreground">{diary.explanation}</p>
        </div>
      </AccordionContent>
    </AccordionItem>
  )
}
