import { Eyebrow } from '@/components/shared'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { channelIsReady } from '@/lib/provider'
import type { Archive, Channel, Persona } from '@/lib/types'
import { ArrowRight, Check } from 'lucide-react'

import type { WorkspaceDialog } from './types'

export function Landing({
  archive,
  channel,
  persona,
  chatting,
  enter,
  onOpenDialog,
}: {
  archive?: Archive
  channel?: Channel
  persona?: Persona
  chatting: boolean
  enter: () => void
  onOpenDialog: (value: WorkspaceDialog) => void
}) {
  return (
    <main className="relative z-10 flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 py-10 sm:py-16">
      <div className="mx-auto flex w-full reading-width flex-col items-center gap-6 text-center">
        <Eyebrow>A PRIVATE NARRATIVE SPACE</Eyebrow>
        <div className="flex flex-col items-center gap-1">
          <span aria-hidden="true" className="font-serif text-hero leading-heading text-primary">
            雎
          </span>
          <h2 className="font-serif text-xl italic text-primary">Abyss & Desire</h2>
        </div>
        <p className="text-chat text-muted-foreground">恨海情天。让故事在此刻继续。</p>
        <div className="flex flex-wrap justify-center gap-3">
          <Button size="lg" onClick={enter}>
            进入聊天
            <ArrowRight data-icon="inline-start" />
          </Button>
          <Button variant="outline" size="lg" onClick={() => onOpenDialog('archives')}>
            打开存档
          </Button>
        </div>
        <div className="mt-8 grid w-full gap-4 text-left sm:grid-cols-2">
          <Card>
            <CardHeader>
              <Eyebrow>01 / CHANNEL</Eyebrow>
              <CardTitle>连接你的模型</CardTitle>
              <CardDescription>支持多渠道与严格结构化输出。</CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" onClick={() => onOpenDialog('channels')}>
                {channel && channelIsReady(channel) ? (
                  <>
                    <Check data-icon="inline-start" />
                    {channel.name}
                  </>
                ) : (
                  '配置渠道'
                )}
              </Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <Eyebrow>02 / PERSONA</Eyebrow>
              <CardTitle>在故事里，成为自己</CardTitle>
              <CardDescription>姓名、身份与规则，每轮生效。</CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" onClick={() => onOpenDialog('personas')}>
                {persona?.name || '创建人设'}
              </Button>
            </CardContent>
          </Card>
        </div>
        <p className="text-xs text-muted-foreground">
          聊天、人设与配置保存在当前浏览器 · 可导出完整存档
        </p>
        {chatting && !archive && (
          <p role="alert" className="text-destructive">
            链接中的存档在此浏览器中不存在，请从存档列表载入或导入。
          </p>
        )}
      </div>
    </main>
  )
}
