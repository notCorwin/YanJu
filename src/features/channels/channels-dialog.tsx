import { ConfirmDialog } from '@/components/shared'
import { Button } from '@/components/ui/button'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { Badge } from '@/components/ui/badge'
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
import { useCallback, useEffect, useRef, useState } from 'react'

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
  const [expandedIds, setExpandedIds] = useState<string[]>([])
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(() => new Set())
  const onDirtyChange = useCallback((id: string, dirty: boolean) => {
    setDirtyIds((previous) => {
      if (previous.has(id) === dirty) return previous
      const next = new Set(previous)
      if (dirty) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])
  const { guard, confirmation } = useUnsavedChanges(dirtyIds.size > 0, page)
  const [testingAll, setTestingAll] = useState(false)
  const [progress, setProgress] = useState('')
  const controller = useRef<AbortController | null>(null)
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
        description="渠道默认折叠，展开后可自定义名称、配置和测试。"
        step="channels"
        onClose={() =>
          guard(() => {
            setExpandedIds([])
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
              void db.channels.add(newChannel()).catch((e) => notify(friendlyError(e), true))
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
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <nav aria-label="渠道列表" className="min-w-0">
            <Accordion
              type="multiple"
              className="accordion-panels"
              value={expandedIds}
              onValueChange={(next) => {
                const close = () => setExpandedIds(next)
                if (expandedIds.some((id) => !next.includes(id) && dirtyIds.has(id))) guard(close)
                else close()
              }}
            >
              {channels.map((channel) => (
                <ChannelPanel
                  key={channel.id}
                  channel={channel}
                  active={settings.activeChannelId === channel.id}
                  notify={notify}
                  disabled={disabled || testingAll}
                  testingAll={testingAll}
                  onDirtyChange={onDirtyChange}
                />
              ))}
            </Accordion>
          </nav>
          {!channels.length && (
            <Empty>
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

function ChannelPanel({
  channel,
  active,
  notify,
  disabled,
  testingAll,
  onDirtyChange,
}: {
  channel: Channel
  active: boolean
  notify: Notify
  disabled: boolean
  testingAll: boolean
  onDirtyChange: (id: string, dirty: boolean) => void
}) {
  const reportDirty = useCallback(
    (dirty: boolean) => onDirtyChange(channel.id, dirty),
    [channel.id, onDirtyChange],
  )
  return (
    <AccordionItem value={channel.id}>
      <AccordionTrigger aria-label={channel.name} disabled={testingAll}>
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {channelIsReady(channel) && (
            <Check aria-hidden="true" className="size-4 shrink-0 text-success" />
          )}
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="truncate">{channel.name}</span>
            <span className="truncate text-xs text-muted-foreground">
              {channel.model || '展开填写渠道配置'}
            </span>
          </span>
          {active && <Badge variant="secondary">当前</Badge>}
        </span>
      </AccordionTrigger>
      <AccordionContent>
        <ChannelEditor
          key={String(testingAll)}
          channel={channel}
          active={active}
          notify={notify}
          disabled={disabled}
          onDirtyChange={reportDirty}
          onUse={async (saved) => {
            await db.settings.update('app', { activeChannelId: saved.id })
            notify(`已切换到 ${saved.name}`)
          }}
        />
      </AccordionContent>
    </AccordionItem>
  )
}
