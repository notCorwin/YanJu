import { Eyebrow } from '@/components/shared'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { NarrativeReply } from '@/lib/schemas'
import type { DeepPartial } from 'ai'

type Scene = DeepPartial<NarrativeReply['scene']>
export function SceneCard({ scene }: { scene: Scene }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          <Eyebrow>SCENE / 场景</Eyebrow>
        </CardTitle>
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            ['时间', scene.time],
            ['地点', scene.location],
            ['在场', scene.characters?.filter(Boolean).join('、')],
          ].map(([name, value]) => (
            <div key={name}>
              <p className="text-xs text-muted-foreground">{name}</p>
              <p className="text-ui">{value || '…'}</p>
            </div>
          ))}
        </div>
      </CardHeader>
      {scene.quoteZh && (
        <CardContent className="flex flex-col gap-2">
          <p className="text-chat leading-prose">{scene.quoteZh}</p>
          <p className="font-serif italic text-sm text-muted-foreground">{scene.quoteEn}</p>
          {scene.source && <p className="text-xs text-primary">— {scene.source}</p>}
        </CardContent>
      )}
    </Card>
  )
}
