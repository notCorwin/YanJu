import {
  archiveIdFromRoute,
  currentRoute,
  navigateRoute,
  subscribeRoute,
} from '@/app/use-hash-route'
import { NarrativeCover } from '@/components/narrative-cover'
import { IconButton } from '@/components/shared'
import { Studio } from '@/components/studio'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
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
import { type ExternalChatRequest } from '@/features/chat/types'
import { PersonasDialog } from '@/features/personas/personas-dialog'
import { WorldPlayer } from '@/features/world/world-player'
import { applyAppearance } from '@/lib/appearance'
import type { SourceRef } from '@/lib/domain-schema'
import { requestTrack } from '@/lib/media'
import { currentModelCatalog, subscribeModelCatalog } from '@/lib/model-catalog'
import { type Notify } from '@/lib/notify'
import { channelIsReady } from '@/lib/provider'
import type { RequestKind } from '@/lib/schemas'
import { db } from '@/lib/storage'
import type { TaskOutput } from '@/lib/tasks'
import { cn } from '@/lib/utils'
import { useBackground } from '@/lib/use-background'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  FolderOpen,
  Home,
  NotebookTabs,
  Settings2,
  SlidersHorizontal,
  VenetianMask,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'

export function Workspace() {
  // Refresh readiness badges and controls when the catalog changes the tested route.
  useSyncExternalStore(subscribeModelCatalog, currentModelCatalog)
  const settings = useLiveQuery(() => db.settings.get('app'))
  const background = useBackground(settings?.bgImage)
  const archives = useLiveQuery(() => db.archives.orderBy('updatedAt').reverse().toArray()) ?? []
  const channels = useLiveQuery(() => db.channels.toArray()) ?? []
  const personas = useLiveQuery(() => db.personas.toArray()) ?? []
  const route = useSyncExternalStore(subscribeRoute, currentRoute)
  const [dialog, setDialog] = useState<
    'channels' | 'personas' | 'appearance' | 'archives' | 'studio' | null
  >(null)
  const [worldOpen, setWorldOpen] = useState(false)
  const [chatBusy, setBusy] = useState(false)
  const [studioBusy, setStudioBusy] = useState(false)
  const busy = chatBusy || studioBusy
  const [externalRequest, setExternalRequest] = useState<ExternalChatRequest | null>(null)
  const pendingSend = useRef<ExternalChatRequest | null>(null)
  const [externalMode, setExternalMode] = useState<RequestKind | null>(null)
  const [insert, setInsert] = useState('')
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const notify = useCallback<Notify>((text, error = false) => {
    setToast({ text, error })
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), error ? 12000 : 6000)
  }, [])
  const onBusy = useCallback((value: boolean) => setBusy(value), [])
  const onInserted = useCallback(() => setInsert(''), [])
  const onExternalHandled = useCallback(() => setExternalRequest(null), [])
  const onModeHandled = useCallback(() => setExternalMode(null), [])
  const onStudioBusy = useCallback((value: boolean) => setStudioBusy(value), [])
  const onSourceHandled = useCallback((messageId: string, blockId?: string) => {
    const [path, query] = window.location.hash.split('?')
    const params = new URLSearchParams(query)
    if (params.get('message') !== messageId || (params.get('block') ?? undefined) !== blockId)
      return
    params.delete('message')
    params.delete('block')
    const rest = params.toString()
    window.history.replaceState(null, '', `${path}${rest ? `?${rest}` : ''}`)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  }, [])
  useEffect(() => () => pendingSend.current?.complete(false), [])
  useEffect(() => {
    if (settings) applyAppearance({ ...settings, bgImage: background })
  }, [settings, background])
  const routeId = archiveIdFromRoute(route)
  const [restoreEpoch, setRestoreEpoch] = useState(0)
  const archive = archives.find((a) => a.id === (routeId || settings?.activeArchiveId))
  const channel = channels.find((c) => c.id === settings?.activeChannelId)
  const persona = personas.find((p) => p.id === settings?.activePersonaId)
  const chatting = route.startsWith('#/chat')
  const setup =
    route === '#/setup/channels' ? 'channels' : route === '#/setup/persona' ? 'persona' : null
  const params = new URLSearchParams(route.split('?')[1] ?? '')
  const studioTab = params.get('studio') ?? undefined
  const sourceMessage = params.get('message') ?? undefined
  const sourceBlock = params.get('block') ?? undefined
  useEffect(() => {
    document.title = chatting
      ? `${archive?.name || '存档未找到'} · 宴雎`
      : setup
        ? `${setup === 'channels' ? '连接渠道' : '选择人设'} · 宴雎`
        : '宴雎'
  }, [chatting, archive?.name, setup])
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current)
    },
    [],
  )
  useEffect(() => {
    if (routeId && archive && settings?.activeArchiveId !== routeId)
      void db.settings.update('app', { activeArchiveId: routeId })
  }, [routeId, archive, settings?.activeArchiveId])
  const selectArchive = (id: string) => {
    void db.settings.update('app', { activeArchiveId: id })
    navigateRoute(`/chat/${encodeURIComponent(id)}`)
  }
  const continueArchive = () => {
    if (archive) selectArchive(archive.id)
    else setDialog('archives')
  }
  const enter = () => {
    if (!channels.length) navigateRoute('/setup/channels')
    else continueArchive()
  }
  const sendFromStudio = (text: string, kind: RequestKind, expectedRevision?: number) => {
    if (!archive || pendingSend.current) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      const request: ExternalChatRequest = {
        id: crypto.randomUUID(),
        text,
        kind,
        expectedRevision,
        complete: (committed) => {
          if (pendingSend.current?.id === request.id) pendingSend.current = null
          resolve(committed)
        },
      }
      pendingSend.current = request
      selectArchive(archive.id)
      setExternalRequest(request)
      setDialog(null)
    })
  }
  const sourceFromStudio = (source: SourceRef) => {
    if (source.messageId === 'setting') {
      closeStudio()
      setWorldOpen(true)
      return
    }
    setDialog(null)
    if (archive)
      navigateRoute(
        `/chat/${encodeURIComponent(archive.id)}?message=${encodeURIComponent(source.messageId)}${source.blockId ? `&block=${encodeURIComponent(source.blockId)}` : ''}`,
      )
  }
  const commandFromStudio = (value: TaskOutput<'command'>) => {
    if (value.action === 'music') {
      if (value.targetId) requestTrack(value.targetId)
      closeStudio()
      setWorldOpen(true)
    } else if (value.action === 'archive') {
      if (value.targetId) {
        selectArchive(value.targetId)
        setDialog(null)
      } else setDialog('archives')
    } else if (value.action === 'mode' && value.mode) {
      continueArchive()
      setExternalMode(value.mode)
      setDialog(null)
    } else if (value.action === 'world') {
      closeStudio()
      setWorldOpen(true)
    } else if (archive && ['character', 'phone'].includes(value.action)) {
      setDialog(null)
      navigateRoute(
        `/chat/${encodeURIComponent(archive.id)}?studio=${value.action === 'phone' ? 'interactions' : 'archives'}&${value.action === 'phone' ? 'contact' : 'entity'}=${encodeURIComponent(value.targetId ?? '')}`,
      )
    }
  }
  const closeStudio = () => {
    setDialog(null)
    if (studioTab && archive) navigateRoute(`/chat/${encodeURIComponent(archive.id)}`)
  }
  const channelControl = channels.some(channelIsReady) ? (
    <Select
      value={channel?.id || ''}
      onValueChange={(value) => void db.settings.update('app', { activeChannelId: value })}
      disabled={busy}
    >
      <SelectTrigger aria-label="当前渠道" className="max-w-40 shrink-0 sm:max-w-64">
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
        </SelectGroup>
      </SelectContent>
    </Select>
  ) : (
    <Button variant="outline" disabled={busy} onClick={() => setDialog('channels')}>
      配置渠道
    </Button>
  )

  if (!settings) return null
  return (
    <div
      data-page={chatting ? 'chat' : setup ? 'setup' : 'home'}
      className="relative isolate flex chat-height flex-col overflow-hidden bg-background atmosphere"
    >
      <a
        href="#main-content"
        className="skip-link"
        onClick={(e) => {
          e.preventDefault()
          document.getElementById('main-content')?.focus()
        }}
      >
        跳到主要内容
      </a>
      <div className="pointer-events-none fixed inset-0 backdrop-scene" aria-hidden="true" />
      <div className="pointer-events-none fixed inset-0 scanlines" aria-hidden="true" />
      {chatting && (
        <header className="surface relative z-10 flex shrink-0 items-center justify-between gap-2 border-b-(length:--border-width) px-3 py-2 sm:px-6">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <IconButton
              label="返回首页"
              onClick={() => {
                if (!busy) navigateRoute('/')
              }}
              disabled={busy}
            >
              <Home />
            </IconButton>
            <div className="min-w-0">
              <h1 className="truncate text-lg tracking-editorial text-primary">宴雎</h1>
              <p className="truncate text-xs text-muted-foreground">
                {archive?.name || '存档未找到'}
              </p>
            </div>
          </div>
          <nav className="flex shrink-0 items-center gap-1" aria-label="应用操作">
            <IconButton
              className="hidden sm:inline-flex"
              label="剧情工作台"
              onClick={() => setDialog('studio')}
              disabled={!archive}
            >
              <NotebookTabs />
            </IconButton>
            <IconButton label="渠道管理" onClick={() => setDialog('channels')}>
              <SlidersHorizontal />
            </IconButton>
            <IconButton label="人设管理" onClick={() => setDialog('personas')}>
              <VenetianMask />
            </IconButton>
            <IconButton label="存档管理" onClick={() => setDialog('archives')}>
              <FolderOpen />
            </IconButton>
            <IconButton label="外观设置" onClick={() => setDialog('appearance')}>
              <Settings2 />
            </IconButton>
          </nav>
        </header>
      )}
      {chatting && archive ? (
        <main
          id="main-content"
          tabIndex={-1}
          className="relative z-10 flex min-h-0 flex-1 flex-col"
        >
          <ChatSession
            key={`${archive.id}:${restoreEpoch}`}
            archive={archive}
            channel={channel}
            channelControl={channelControl}
            persona={persona}
            notify={notify}
            onBusy={onBusy}
            onWorld={() => setWorldOpen(true)}
            onChannels={() => setDialog('channels')}
            insert={insert}
            onInserted={onInserted}
            externalRequest={externalRequest}
            onExternalHandled={onExternalHandled}
            externalMode={externalMode}
            onModeHandled={onModeHandled}
            sourceMessage={sourceMessage}
            sourceBlock={sourceBlock}
            onSourceHandled={onSourceHandled}
            disabled={studioBusy}
            onStudio={() => setDialog('studio')}
          />
        </main>
      ) : chatting ? (
        <main
          id="main-content"
          tabIndex={-1}
          className="relative z-10 flex min-h-0 flex-1 overflow-y-auto px-4 py-8"
        >
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FolderOpen />
              </EmptyMedia>
              <EmptyTitle>这个篇章尚未在此浏览器保存</EmptyTitle>
              <EmptyDescription>
                可以从存档列表打开已有篇章，或导入之前导出的文件，继续阅读和聊天。
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={() => setDialog('archives')}>打开存档列表</Button>
              <Button
                variant="outline"
                onClick={() => {
                  navigateRoute('/')
                }}
              >
                返回首页
              </Button>
            </EmptyContent>
          </Empty>
        </main>
      ) : setup ? (
        <main
          id="main-content"
          tabIndex={-1}
          className="relative z-10 flex min-h-0 flex-1 flex-col px-4 py-4 sm:px-6 sm:py-6"
        >
          {setup === 'channels' ? (
            <ChannelsDialog
              page
              open
              onClose={() => {
                navigateRoute('/')
              }}
              onContinue={() => {
                navigateRoute('/setup/persona')
              }}
              channels={channels}
              settings={settings}
              notify={notify}
              disabled={busy}
            />
          ) : (
            <PersonasDialog
              page
              open
              onClose={() => {
                navigateRoute('/')
              }}
              onContinue={continueArchive}
              personas={personas}
              settings={settings}
              notify={notify}
              disabled={busy}
            />
          )}
        </main>
      ) : (
        <main
          id="main-content"
          tabIndex={-1}
          className="relative z-10 flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-4 pt-16 pb-6 sm:px-6 sm:py-8"
        >
          <div className="my-auto flex w-full flex-col items-center gap-4 py-2 sm:gap-6">
            <NarrativeCover onEnter={enter} />
            <nav
              aria-label="应用操作"
              className="flex max-w-full flex-wrap justify-center gap-1 sm:gap-3"
            >
              <Button variant="ghost" onClick={() => setDialog('channels')}>
                渠道管理
              </Button>
              <Button variant="ghost" onClick={() => setDialog('personas')}>
                人设管理
              </Button>
              <Button variant="ghost" onClick={() => setDialog('archives')}>
                存档管理
              </Button>
              <Button variant="ghost" onClick={() => setDialog('appearance')}>
                外观设置
              </Button>
              <Button variant="ghost" onClick={() => setWorldOpen(true)}>
                世界与音乐
              </Button>
            </nav>
            <p className="text-center text-xs text-muted-foreground">
              聊天、人设与配置保存在当前浏览器 · 可导出完整存档
            </p>
          </div>
        </main>
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
        onRestored={() => setRestoreEpoch((value) => value + 1)}
        onSelect={selectArchive}
        notify={notify}
        disabled={busy}
      />
      {archive && (
        <Studio
          key={`${archive.id}:${studioTab ?? ''}:${params.get('contact') ?? ''}:${params.get('entity') ?? ''}`}
          open={dialog === 'studio' || (!dialog && !!studioTab)}
          onClose={closeStudio}
          archive={archive}
          disabled={chatBusy}
          onBusy={onStudioBusy}
          onSend={sendFromStudio}
          onSource={sourceFromStudio}
          onCommand={commandFromStudio}
          notify={notify}
          initialTab={studioTab}
          initialContact={params.get('contact') ?? undefined}
          initialEntity={params.get('entity') ?? undefined}
        />
      )}
      <WorldPlayer
        open={worldOpen}
        onOpen={() => setWorldOpen(true)}
        onClose={() => setWorldOpen(false)}
        notify={notify}
        onInsert={(text) => {
          setInsert(text)
          continueArchive()
        }}
      />
      {createPortal(
        <div
          data-toast-region
          aria-live="polite"
          aria-atomic="true"
          className="toast-layer pointer-events-auto fixed top-20 right-4 max-w-[calc(100%-2rem)] panel-width"
        >
          {toast && (
            <div
              data-global-toast
              role={toast.error ? 'alert' : 'status'}
              className="flex animate-message items-start gap-3 rounded-lg border-(length:--border-width) bg-popover popover-glass edge-accent p-4 shadow-lg"
            >
              <p
                className={cn(
                  'min-w-0 flex-1 wrap-break-word text-sm',
                  toast.error ? 'text-destructive' : 'text-foreground',
                )}
              >
                {toast.text}
              </p>
              <IconButton label="关闭提示" onClick={() => setToast(null)}>
                <X />
              </IconButton>
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}
