import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { channelIsReady } from '@/lib/provider'
import { type Channel, type Notify, type Settings } from '@/lib/types'
import { Check, Plus } from 'lucide-react'
import { useChannels } from './use-channels'
import { useChannelTests } from './use-channel-tests'

import { ChannelEditor } from './channel-editor'

export function ChannelsDialog({
  open,
  onClose,
  channels,
  settings,
  notify,
  disabled,
}: {
  open: boolean
  onClose: () => void
  channels: Channel[]
  settings: Settings
  notify: Notify
  disabled: boolean
}) {
  const { selected, setSelectedId, add, activateSelected, creating } = useChannels(
    channels,
    settings,
    notify,
  )
  const { testingAll, progress, testAll, cancel } = useChannelTests(channels, notify)
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          cancel()
          onClose()
        }
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:page-width">
        <DialogHeader>
          <DialogTitle>渠道管理</DialogTitle>
          <DialogDescription>保存多个服务商配置，通过测试后可以随时切换。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-2">
          <Button disabled={disabled || testingAll || creating} onClick={() => void add()}>
            <Plus data-icon="inline-start" />
            新建渠道
          </Button>
          {testingAll ? (
            <Button variant="outline" onClick={() => cancel()}>
              取消全部测试
            </Button>
          ) : (
            <Button
              disabled={disabled || creating || !channels.length}
              variant="outline"
              onClick={() => void testAll()}
            >
              测试全部
            </Button>
          )}
        </div>
        {testingAll && <p role="status">{progress || '正在测试渠道…'}</p>}
        <div className="grid gap-4 md:grid-cols-[1fr_2fr]">
          <nav aria-label="渠道列表" className="flex flex-col gap-2">
            {channels.map((c) => (
              <Button
                key={c.id}
                variant={selected?.id === c.id ? 'secondary' : 'ghost'}
                className="justify-start overflow-hidden"
                disabled={testingAll || creating}
                onClick={() => setSelectedId(c.id)}
              >
                {channelIsReady(c) && <Check data-icon="inline-start" />}
                <span className="truncate">{c.name}</span>
              </Button>
            ))}
            {!channels.length && <p className="text-muted-foreground">从「新建渠道」开始。</p>}
          </nav>
          {selected && (
            <ChannelEditor
              key={selected.id + String(testingAll)}
              channel={selected}
              active={settings.activeChannelId === selected.id}
              notify={notify}
              disabled={disabled || testingAll || creating}
              onUse={() => void activateSelected()}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
