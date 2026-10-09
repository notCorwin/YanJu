import { Eyebrow } from '@/components/shared'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import type { NarrativeReply } from '@/lib/schemas'
import type { DeepPartial } from 'ai'

export type Scene = DeepPartial<NarrativeReply['scene']>

export function SceneCard({ scene }: { scene: Scene }) {
  return (
    <Card size="sm" className="edge-accent">
      <CardHeader>
        <Eyebrow>SCENE / 场景</Eyebrow>
        <div className="grid grid-cols-2 gap-3 border-b-(length:--border-width) border-dashed pb-3 sm:grid-cols-3">
          {[
            ['时间', scene.time],
            ['地点', scene.location],
            ['在场', scene.characters?.filter(Boolean).join('、')],
          ].map(([name, value]) => (
            <div key={name} className="min-w-0 first:col-span-2 sm:first:col-span-1">
              <p className="font-mono text-xs tracking-editorial text-primary-muted">{name}</p>
              <p className="wrap-anywhere text-ui">{value || '…'}</p>
            </div>
          ))}
        </div>
      </CardHeader>
      {scene.quoteZh && (
        <CardContent className="flex flex-col gap-2">
          <p className="text-chat leading-prose tracking-prose">{scene.quoteZh}</p>
          <p className="font-serif italic text-sm text-primary-muted">{scene.quoteEn}</p>
          {scene.source && (
            <p className="text-right font-mono text-xs tracking-editorial text-foreground-dim">
              — {scene.source}
            </p>
          )}
        </CardContent>
      )}
    </Card>
  )
}
