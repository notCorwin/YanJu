import { Prose } from '@/components/shared'
import type { NarrativeReply } from '@/lib/schemas'
import { cn } from '@/lib/utils'
import type { DeepPartial } from 'ai'

export function NarrativeBody({
  blocks,
}: {
  blocks: DeepPartial<NarrativeReply['blocks']> | undefined
}) {
  return (
    <div className="flex flex-col gap-5">
      {blocks?.map(
        (block, i) =>
          block && (
            <div
              key={i}
              className={cn(
                block.kind === 'dialogue' && 'border-l-(length:--border-width) border-primary pl-4',
              )}
            >
              <Prose text={block.text} />
              {block.kind === 'dialogue' && block.translation && (
                <p className="mt-2 text-ui text-muted-foreground">「{block.translation}」</p>
              )}
            </div>
          ),
      )}
    </div>
  )
}
