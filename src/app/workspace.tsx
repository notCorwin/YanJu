import { Eyebrow } from '@/components/shared'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { AppearanceDialog } from '@/features/appearance/appearance-dialog'
import { ArchivesSheet } from '@/features/archives/archives-sheet'
import { ChannelsDialog } from '@/features/channels/channels-dialog'
import { ChatSession } from '@/features/chat/chat-session'
import { PersonasDialog } from '@/features/personas/personas-dialog'
import { WorldPlayer } from '@/features/world/world-player'
import { applyAppearance } from '@/lib/appearance'
import { channelIsReady } from '@/lib/provider'
import { db } from '@/lib/storage'
import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useEffect, useState } from 'react'

import { Landing } from './landing'
import type { WorkspaceDialog } from './types'
import { useHashRoute } from './use-hash-route'
import { useNotify } from './use-notify'
import { WorkspaceHeader } from './workspace-header'

export function Workspace() {
  const settings = useLiveQuery(() => db.settings.get('app'))
  const archives = useLiveQuery(() => db.archives.orderBy('updatedAt').reverse().toArray()) ?? []
  const channels = useLiveQuery(() => db.channels.toArray()) ?? []
  const personas = useLiveQuery(() => db.personas.toArray()) ?? []
  const { route, routeId } = useHashRoute()
  const [dialog, setDialog] = useState<WorkspaceDialog>(null)
  const [busy, setBusy] = useState(false)
  const [insert, setInsert] = useState('')
  const notify = useNotify()
  const onBusy = useCallback((value: boolean) => setBusy(value), [])
  const onInserted = useCallback(() => setInsert(''), [])
  useEffect(() => {
    if (settings) applyAppearance(settings)
  }, [settings])
  const archive = archives.find((a) => a.id === (routeId || settings?.activeArchiveId))
  const channel = channels.find((c) => c.id === settings?.activeChannelId)
  const persona = personas.find((p) => p.id === settings?.activePersonaId)
  const chatting = route.startsWith('#/chat')
  useEffect(() => {
    if (routeId && archive && settings?.activeArchiveId !== routeId)
      void db.settings.update('app', { activeArchiveId: routeId })
  }, [routeId, archive, settings?.activeArchiveId])
  const selectArchive = (id: string) => {
    void db.settings.update('app', { activeArchiveId: id })
    window.location.hash = `/chat/${encodeURIComponent(id)}`
  }
  const enter = () => {
    if (archive) selectArchive(archive.id)
    else setDialog('archives')
  }
  if (!settings) return null
  return (
    <div className="relative isolate flex chat-height flex-col overflow-hidden bg-background">
      <div className="pointer-events-none fixed inset-0 backdrop-scene" aria-hidden="true" />
      <WorkspaceHeader
        busy={busy}
        chatting={chatting}
        archive={archive}
        onHome={() => {
          if (!busy) window.location.hash = '/'
        }}
        onOpenDialog={setDialog}
      />
      {chatting && archive ? (
        <main className="relative z-10 flex min-h-0 flex-1 flex-col">
          <div className="surface flex flex-wrap items-center justify-between gap-2 border-b-(length:--border-width) px-4 py-2 sm:px-6">
            <div className="flex min-w-0 items-center gap-2">
              <Eyebrow>宴雎 / {persona?.name || '沈辞玉'}</Eyebrow>
            </div>
            <Select
              value={channel?.id || ''}
              onValueChange={(value) => void db.settings.update('app', { activeChannelId: value })}
              disabled={busy}
            >
              <SelectTrigger aria-label="当前渠道">
                <SelectValue placeholder="选择已测试渠道" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {channels.map((c) => (
                    <SelectItem key={c.id} value={c.id} disabled={!channelIsReady(c)}>
                      {c.name}
                      {channelIsReady(c) ? '' : ' · 需测试'}
                    </SelectItem>
                  ))}
                  {!channels.length && (
                    <SelectItem value="no-channel" disabled>
                      请先添加渠道
                    </SelectItem>
                  )}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <ChatSession
            key={archive.id}
            archive={archive}
            channel={channel}
            persona={persona}
            notify={notify}
            onBusy={onBusy}
            onWorld={() => setDialog('world')}
            insert={insert}
            onInserted={onInserted}
          />
        </main>
      ) : (
        <Landing
          archive={archive}
          channel={channel}
          persona={persona}
          chatting={chatting}
          enter={enter}
          onOpenDialog={setDialog}
        />
      )}
      <ChannelsDialog
        open={dialog === 'channels'}
        onClose={() => setDialog(null)}
        channels={channels}
        settings={settings}
        notify={notify}
        disabled={busy}
      />
      <PersonasDialog
        open={dialog === 'personas'}
        onClose={() => setDialog(null)}
        personas={personas}
        settings={settings}
        notify={notify}
        disabled={busy}
      />
      <AppearanceDialog
        open={dialog === 'appearance'}
        onClose={() => setDialog(null)}
        settings={settings}
        notify={notify}
      />
      <ArchivesSheet
        open={dialog === 'archives'}
        onClose={() => setDialog(null)}
        archives={archives}
        activeId={archive?.id || ''}
        onSelect={selectArchive}
        notify={notify}
        disabled={busy}
      />
      <WorldPlayer
        open={dialog === 'world'}
        onClose={() => setDialog(null)}
        notify={notify}
        onInsert={(text) => {
          setInsert(text)
          enter()
        }}
      />
    </div>
  )
}
