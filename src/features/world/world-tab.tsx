import { Prose } from '@/components/shared'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import world from '@/content/world.json'

export function WorldTab() {
  return (
    <Accordion type="multiple" defaultValue={['0']}>
      {world.map((item, i) => (
        <AccordionItem key={i} value={String(i)}>
          <AccordionTrigger>{item.label}</AccordionTrigger>
          <AccordionContent>
            <Prose text={item.text} />
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  )
}
