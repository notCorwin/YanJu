import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, initializeStorage } from '@/lib/db'
import { applyAppearance } from '@/lib/appearance'
import { channelIsReady, friendlyError } from '@/lib/provider'
import { ChatSession } from '@/components/chat'
import {
  AppearanceDialog,
  ArchivesSheet,
  ChannelsDialog,
  PersonasDialog,
  type Notify,
} from '@/components/managers'
import { WorldPlayer } from '@/components/world-player'
import { Studio } from '@/components/studio'
import { requestTrack } from '@/lib/media'
import type { SourceRef } from '@/lib/domain-schema'
import type { TaskOutput } from '@/lib/tasks'
import type { RequestKind } from '@/lib/schemas'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { IconButton, Eyebrow } from '@/components/shared'
import {
  ArrowRight,
  BookOpen,
  Check,
  FolderOpen,
  Home,
  Settings2,
  SlidersHorizontal,
  VenetianMask,
  NotebookTabs,
  X,
} from 'lucide-react'

const subscribeRoute = (notify: () => void) => {
  window.addEventListener('hashchange', notify)
  return () => window.removeEventListener('hashchange', notify)
}
const currentRoute = () => window.location.hash

export default function App() {
  const [ready, setReady] = useState(false)
  const [failure, setFailure] = useState('')
  useEffect(() => {
    void initializeStorage()
      .then(() => setReady(true))
      .catch((e) => setFailure(friendlyError(e)))
  }, [])
  if (failure)
    return (
      <main className="mx-auto flex page-width flex-col gap-6 p-8">
        <h1 className="text-xl">本地资料尚未打开</h1>
        <p role="alert">{failure}</p>
        <p>请确认浏览器允许 IndexedDB，或重新载入后导入存档。</p>
        <Button className="w-fit" onClick={() => location.reload()}>
          重新载入
        </Button>
      </main>
    )
  if (!ready)
    return (
      <main className="flex chat-height items-center justify-center text-primary" role="status">
        宴雎 · 正在打开篇章…
      </main>
    )
  return <Workspace />
}
function Workspace() {
  const settings = useLiveQuery(() => db.settings.get('app'))
  const archives = useLiveQuery(() => db.archives.orderBy('updatedAt').reverse().toArray()) ?? []
  const channels = useLiveQuery(() => db.channels.toArray()) ?? []
  const personas = useLiveQuery(() => db.personas.toArray()) ?? []
  const route = useSyncExternalStore(subscribeRoute, currentRoute)
  const [dialog, setDialog] = useState<
    'channels' | 'personas' | 'appearance' | 'archives' | 'world' | 'studio' | null
  >(null)
  const [chatBusy, setBusy] = useState(false)
  const [studioBusy, setStudioBusy] = useState(false)
  const busy = chatBusy || studioBusy
  const [externalRequest, setExternalRequest] = useState<{
    id: string
    text: string
    kind: RequestKind
  } | null>(null)
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
  useEffect(() => {
    if (settings) applyAppearance(settings)
  }, [settings])
  const routeId = route.startsWith('#/chat/')
    ? decodeURIComponent(route.slice(7).split('?')[0])
    : ''
  const archive = archives.find((a) => a.id === (routeId || settings?.activeArchiveId))
  const channel = channels.find((c) => c.id === settings?.activeChannelId)
  const persona = personas.find((p) => p.id === settings?.activePersonaId)
  const chatting = route.startsWith('#/chat')
  const params = new URLSearchParams(route.split('?')[1] ?? '')
  const studioTab = params.get('studio') ?? undefined
  const sourceMessage = params.get('message') ?? undefined
  const sourceBlock = params.get('block') ?? undefined
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
  const sendFromStudio = (text: string, kind: RequestKind) => {
    if (archive) {
      selectArchive(archive.id)
      setExternalRequest({ id: crypto.randomUUID(), text, kind })
      setDialog(null)
    }
  }
  const sourceFromStudio = (source: SourceRef) => {
    if (source.messageId === 'setting') {
      setDialog('world')
      return
    }
    setDialog(null)
    if (archive)
      window.location.hash = `/chat/${encodeURIComponent(archive.id)}?message=${encodeURIComponent(source.messageId)}${source.blockId ? `&block=${encodeURIComponent(source.blockId)}` : ''}`
  }
  const commandFromStudio = (value: TaskOutput<'command'>) => {
    if (value.action === 'music') {
      if (value.targetId) requestTrack(value.targetId)
      setDialog('world')
    } else if (value.action === 'archive') {
      if (value.targetId) {
        selectArchive(value.targetId)
        setDialog(null)
      } else setDialog('archives')
    } else if (value.action === 'mode' && value.mode) {
      enter()
      setExternalMode(value.mode)
      setDialog(null)
    } else if (value.action === 'world') setDialog('world')
    else if (archive && ['character', 'phone'].includes(value.action)) {
      setDialog(null)
      window.location.hash = `/chat/${encodeURIComponent(archive.id)}?studio=${value.action === 'phone' ? 'interactions' : 'archives'}&${value.action === 'phone' ? 'contact' : 'entity'}=${encodeURIComponent(value.targetId ?? '')}`
    }
  }
  const closeStudio = () => {
    setDialog(null)
    if (studioTab && archive) window.location.hash = `/chat/${encodeURIComponent(archive.id)}`
  }
  if (!settings) return null
  return (
    <div className="relative isolate flex chat-height flex-col overflow-hidden bg-background">
      <div className="pointer-events-none fixed inset-0 backdrop-scene" aria-hidden="true" />
      <header className="surface relative z-10 flex shrink-0 flex-wrap items-center justify-between gap-2 border-b-(length:--border-width) px-3 py-2 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <IconButton
            label="返回首页"
            onClick={() => {
              if (!busy) window.location.hash = '/'
            }}
            disabled={busy}
          >
            <Home />
          </IconButton>
          <div className="min-w-0">
            <h1 className="text-lg text-primary">宴雎</h1>
            <p className="truncate text-xs text-muted-foreground">
              {chatting ? archive?.name || '存档未找到' : 'Abyss & Desire'}
            </p>
          </div>
        </div>
        <nav className="flex flex-wrap items-center gap-1" aria-label="应用操作">
          <IconButton label="剧情工作台" onClick={() => setDialog('studio')} disabled={!archive}>
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
          {!chatting && (
            <IconButton label="世界与音乐" onClick={() => setDialog('world')}>
              <BookOpen />
            </IconButton>
          )}
        </nav>
      </header>
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
            externalRequest={externalRequest}
            onExternalHandled={onExternalHandled}
            externalMode={externalMode}
            onModeHandled={onModeHandled}
            sourceMessage={sourceMessage}
            sourceBlock={sourceBlock}
            onStudio={() => setDialog('studio')}
          />
        </main>
      ) : (
        <main className="relative z-10 flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 py-10 sm:py-16">
          <div className="mx-auto flex w-full reading-width flex-col items-center gap-6 text-center">
            <Eyebrow>A PRIVATE NARRATIVE SPACE</Eyebrow>
            <div className="flex flex-col items-center gap-1">
              <span
                aria-hidden="true"
                className="font-serif text-hero leading-heading text-primary"
              >
                雎
              </span>
              <h2 className="font-serif text-xl italic text-primary">Abyss & Desire</h2>
            </div>
            <p className="text-chat text-muted-foreground">恨海情天。让故事在此刻继续。</p>
            <div className="flex flex-wrap justify-center gap-3">
              <Button size="lg" onClick={enter}>
                进入聊天
                <ArrowRight />
              </Button>
              <Button variant="outline" size="lg" onClick={() => setDialog('archives')}>
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
                  <Button variant="outline" onClick={() => setDialog('channels')}>
                    {channel && channelIsReady(channel) ? (
                      <>
                        <Check />
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
                  <Button variant="outline" onClick={() => setDialog('personas')}>
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
        open={dialog === 'world'}
        onClose={() => setDialog(null)}
        notify={notify}
        onInsert={(text) => {
          setInsert(text)
          enter()
        }}
      />
      {toast && (
        <div
          role={toast.error ? 'alert' : 'status'}
          className="fixed top-20 right-4 z-50 flex max-w-[calc(100%-2rem)] panel-width items-start gap-3 rounded-lg border-(length:--border-width) bg-popover p-4 shadow-lg"
        >
          <p
            className={`min-w-0 flex-1 wrap-break-word text-sm ${toast.error ? 'text-destructive' : 'text-foreground'}`}
          >
            {toast.text}
          </p>
          <IconButton label="关闭提示" onClick={() => setToast(null)}>
            <X />
          </IconButton>
        </div>
      )}
    </div>
  )
}
