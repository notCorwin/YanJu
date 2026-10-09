import { ConfirmDialog } from '@/components/shared'
import { Button } from '@/components/ui/button'
import { ManagementSurface } from '@/components/management-surface'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { ChannelEditor } from '@/features/channels/channel-editor'
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes'
import { channelFingerprint } from '@/lib/channels'
import type { Notify } from '@/lib/notify'
import { channelIsReady, friendlyError, testChannel } from '@/lib/provider'
import { commitChannelCapability, db } from '@/lib/storage'
import { newChannel, type Channel, type ChannelCapability, type Settings } from '@/lib/types'
import { Check, Plus, SlidersHorizontal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

export function ChannelsDialog({
  open,
  onClose,
  channels,
  settings,
  notify,
  disabled,
  page = false,
  onContinue,
}: {
  open: boolean
  onClose: () => void
  channels: Channel[]
  settings: Settings
  notify: Notify
  disabled: boolean
  page?: boolean
  onContinue?: () => void
}) {
  const [selectedId, setSelectedId] = useState('')
  const [dirty, setDirty] = useState(false)
  const { guard, confirmation } = useUnsavedChanges(dirty, page)
  const [testingAll, setTestingAll] = useState(false)
  const [progress, setProgress] = useState('')
  const controller = useRef<AbortController | null>(null)
  const selected =
    channels.find((c) => c.id === selectedId) ??
    channels.find((c) => c.id === settings.activeChannelId) ??
    channels[0]
  const testAll = async () => {
    setTestingAll(true)
    controller.current = new AbortController()
    let discarded = 0
    try {
      for (const snapshot of channels) {
        if (controller.current.signal.aborted) break
        const channel = await db.channels.get(snapshot.id)
        if (!channel) continue
        let capability: ChannelCapability
        try {
          capability = await testChannel(channel, controller.current.signal, undefined, (detail) =>
            setProgress(`${channel.name}：${detail}`),
          )
        } catch (e) {
          if (controller.current.signal.aborted) break
          capability = {
            fingerprint: channelFingerprint(channel),
            testedAt: Date.now(),
            ok: false,
            error: friendlyError(e),
          }
        }
        if (!(await commitChannelCapability(channel, capability))) discarded++
      }
      notify(
        discarded
          ? `渠道测试已结束；${discarded} 个渠道配置已变更或删除，旧测试结果未保存。请重新测试。`
          : '渠道测试已结束，结果显示在各渠道配置中。',
      )
    } catch (e) {
      notify(friendlyError(e), true)
    } finally {
      setTestingAll(false)
      setProgress('')
    }
  }
  useEffect(() => () => controller.current?.abort(), [])
  return (
    <>
      <ManagementSurface
        page={page}
        open={open}
        title="渠道管理"
        description="保存多个服务商配置，通过测试后可以随时切换。"
        step="channels"
        onClose={() =>
          guard(() => {
            controller.current?.abort()
            onClose()
          })
        }
        onContinue={() => guard(() => onContinue?.())}
        continueDisabled={
          disabled ||
          testingAll ||
          !channels.some((c) => c.id === settings.activeChannelId && channelIsReady(c))
        }
      >
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={disabled || testingAll}
            onClick={() =>
              guard(() => {
                const c = newChannel()
                void db.channels
                  .add(c)
                  .then(() => setSelectedId(c.id))
                  .catch((e) => notify(friendlyError(e), true))
              })
            }
          >
            <Plus />
            新建渠道
          </Button>
          {testingAll ? (
            <Button variant="outline" onClick={() => controller.current?.abort()}>
              取消全部测试
            </Button>
          ) : (
            <Button
              disabled={disabled || !channels.length}
              variant="outline"
              onClick={() => guard(() => void testAll())}
            >
              测试全部
            </Button>
          )}
        </div>
        {testingAll && <p role="status">{progress || '正在测试渠道…'}</p>}
        <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-4 md:grid-cols-[1fr_2fr] md:grid-rows-1">
          <nav
            aria-label="渠道列表"
            className="flex min-w-0 gap-2 overflow-x-auto pb-1 md:flex-col md:overflow-y-auto"
          >
            {channels.map((c) => (
              <Button
                key={c.id}
                variant={selected?.id === c.id ? 'secondary' : 'ghost'}
                className="min-w-0 justify-start overflow-hidden md:shrink-0"
                aria-current={selected?.id === c.id ? 'true' : undefined}
                disabled={testingAll}
                onClick={() => selected?.id !== c.id && guard(() => setSelectedId(c.id))}
              >
                {channelIsReady(c) && <Check />}
                <span className="truncate">{c.name}</span>
              </Button>
            ))}
            {!channels.length && <p className="text-muted-foreground">从「新建渠道」开始。</p>}
          </nav>
          {!selected && (
            <Empty className="md:col-span-2">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SlidersHorizontal />
                </EmptyMedia>
                <EmptyTitle>连接你的第一个渠道</EmptyTitle>
                <EmptyDescription>
                  点击「新建渠道」，选择 Provider 和模型，填写 API Key。通过测试后即可开始聊天。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          {selected && (
            <ChannelEditor
              key={selected.id + String(testingAll)}
              channel={selected}
              onDirtyChange={setDirty}
              active={settings.activeChannelId === selected.id}
              notify={notify}
              disabled={disabled || testingAll}
              onUse={async (channel) => {
                await db.settings.update('app', { activeChannelId: channel.id })
                notify(`已切换到 ${channel.name}`)
              }}
            />
          )}
        </div>
      </ManagementSurface>
      <ConfirmDialog
        {...confirmation}
        title="放弃未保存的修改？"
        detail="修改还没有保存。可以取消返回编辑，或放弃修改后继续。"
        confirmLabel="放弃修改"
        destructive={false}
      />
    </>
  )
}
