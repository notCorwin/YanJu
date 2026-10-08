import { Accordion } from '@/components/ui/accordion'
import type { NarrativeReply } from '@/lib/schemas'
import type { DeepPartial } from 'ai'

import { DiaryPanel } from './diary-panel'
import { NarrativeBody } from './narrative-body'
import { PhonePanel } from './phone-panel'
import { SceneCard } from './scene-card'
import { StatePanel } from './state-panel'

export function NarrativeView({ reply }: { reply: DeepPartial<NarrativeReply> }) {
  return (
    <div className="flex flex-col gap-6">
      {reply.scene && <SceneCard scene={reply.scene} />}
      <NarrativeBody blocks={reply.blocks} />
      <Accordion type="multiple">
        <StatePanel state={reply.state} />
        <PhonePanel phone={reply.phone} />
        <DiaryPanel diary={reply.diary} />
      </Accordion>
    </div>
  )
}
