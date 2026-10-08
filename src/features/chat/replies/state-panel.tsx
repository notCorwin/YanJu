import { Eyebrow, Prose } from '@/components/shared'
import { AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import type { NarrativeReply } from '@/lib/schemas'
import type { DeepPartial } from 'ai'

import { Section } from './section'

export function StatePanel({ state }: { state: DeepPartial<NarrativeReply['state']> | undefined }) {
  if (!state) return null
  return (
    <AccordionItem value="state">
      <AccordionTrigger>
        <span className="flex flex-col gap-1">
          <Eyebrow>STATE / INTERNAL</Eyebrow>
          <span>宴雎 · 此刻</span>
        </span>
      </AccordionTrigger>
      <AccordionContent>
        <div className="flex flex-col gap-6 py-3">
          <Section title="心声">
            <Prose text={state.innerVoice} />
          </Section>
          <Section title="欲望">
            <Prose text={state.desire} />
          </Section>
          <Section title="当前最想做的是">
            <ol className="flex list-decimal flex-col gap-3 pl-5">
              {state.wishes?.map((text, i) => (
                <li key={i}>
                  <Prose text={text} />
                </li>
              ))}
            </ol>
          </Section>
          <Section title="正文中的一句话">
            <Prose text={state.spokenLine} />
            <p className="text-ui text-muted-foreground">→ {state.subtext}</p>
          </Section>
        </div>
      </AccordionContent>
    </AccordionItem>
  )
}
