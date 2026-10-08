import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  db,
  createArchive,
  exportSave,
  importSave,
  initializeStorage,
  normalizeImport,
} from '@/lib/db'
import { channelIsReady, friendlyError, testChannel, validateChannel } from '@/lib/provider'
import {
  newChannel,
  newPersona,
  type Archive,
  type Channel,
  type Persona,
  type Settings,
} from '@/lib/types'
import { Button } from './ui/button'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from './ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from './ui/sheet'
import { FieldGroup, Field, FieldLabel, FieldDescription } from './ui/field'
import { Input } from './ui/input'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from './ui/select'
import { Badge } from './ui/badge'
import { ConfirmDialog, FormField, IconButton } from './shared'
import {
  Check,
  Plus,
  Trash2,
  FlaskConical,
  Download,
  Upload,
  PenLine,
  LoaderCircle,
} from 'lucide-react'

export type Notify = (message: string, error?: boolean) => void
const formatDate = (value: number) => new Date(value).toLocaleString('zh-CN', { hour12: false })

function ChannelEditor({
  channel,
  active,
  notify,
  onUse,
  disabled,
}: {
  channel: Channel
  active: boolean
  notify: Notify
  onUse: () => void
  disabled: boolean
}) {
  const [draft, setDraft] = useState(channel)
  const [busy, setBusy] = useState(false)
  const [remove, setRemove] = useState(false)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  const update = (key: keyof Channel, value: string | number) =>
    setDraft((d) => ({
      ...d,
      [key]: value,
      capability: undefined,
      calibration: key === 'model' || key === 'baseUrl' ? undefined : d.calibration,
    }))
  const save = async () => {
    try {
      validateChannel(draft)
      await db.channels.put(draft)
      notify('渠道已保存；通过测试后可用于聊天。')
    } catch (e) {
      notify(friendlyError(e), true)
    }
  }
  const test = async () => {
    controller.current = new AbortController()
    setBusy(true)
    try {
      validateChannel(draft)
      await db.channels.put(draft)
      const capability = await testChannel(draft, controller.current.signal)
      const next = { ...draft, capability }
      setDraft(next)
      await db.channels.put(next)
      notify('严格 JSON Schema 输出和浏览器连接测试通过。')
    } catch (e) {
      const error = friendlyError(e)
      notify(error, true)
      const next = {
        ...draft,
        capability: { fingerprint: '', testedAt: Date.now(), ok: false, error },
      }
      setDraft(next)
      await db.channels.put(next)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>{draft.name}</CardTitle>
          {active && <Badge>当前渠道</Badge>}
        </div>
        <CardDescription>
          请求直接从你的浏览器发送到渠道。服务端须支持严格 JSON Schema 和跨域访问。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <fieldset disabled={busy || disabled} className="flex min-w-0 flex-col gap-5">
          <FieldGroup>
            <FormField
              label="渠道名称"
              value={draft.name}
              onChange={(v) => update('name', v)}
              autoComplete="off"
            />
            <FormField
              label="Base URL"
              value={draft.baseUrl}
              onChange={(v) => update('baseUrl', v)}
              placeholder="https://example.com/v1"
              type="url"
              help="填写 API 根地址，不含 /chat/completions。"
              autoComplete="url"
            />
            <FormField
              label="API Key"
              value={draft.apiKey}
              onChange={(v) => update('apiKey', v)}
              type="password"
              autoComplete="off"
            />
            <FormField
              label="模型"
              value={draft.model}
              onChange={(v) => update('model', v)}
              placeholder="填写渠道提供的模型 ID"
              autoComplete="off"
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                label="温度"
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={draft.temperature}
                onChange={(v) => update('temperature', Number(v))}
              />
              <FormField
                label="输出上限（tokens）"
                type="number"
                min={128}
                step={128}
                value={draft.maxOutputTokens}
                onChange={(v) => update('maxOutputTokens', Number(v))}
              />
            </div>
            <FormField
              label="上下文容量（tokens）"
              value={draft.contextWindow}
              onChange={(v) => update('contextWindow', Number(v))}
              type="number"
              min={1024}
              step={1024}
              help="默认 32,768；按模型实际容量填写。输入占用达到 85% 或输出空间不足时自动压缩。"
            />
          </FieldGroup>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void save()}>保存渠道</Button>
            <Button variant="outline" onClick={() => void test()}>
              <FlaskConical />
              测试渠道
            </Button>
            <Button variant="secondary" disabled={!channelIsReady(draft)} onClick={onUse}>
              <Check />
              使用此渠道
            </Button>
            <IconButton label="删除渠道" variant="destructive" onClick={() => setRemove(true)}>
              <Trash2 />
            </IconButton>
          </div>
        </fieldset>
        {busy && (
          <div className="mt-3 flex items-center gap-2" role="status">
            <LoaderCircle className="animate-spin" />
            正在测试…
            <Button variant="ghost" onClick={() => controller.current?.abort()}>
              取消测试
            </Button>
          </div>
        )}
        {draft.capability?.ok && (
          <p className="mt-3 text-sm text-success">
            测试通过 · {formatDate(draft.capability.testedAt)}
          </p>
        )}
        {draft.capability?.error && (
          <p className="mt-3 wrap-break-word text-sm text-destructive" role="alert">
            {draft.capability.error}
          </p>
        )}
        <ConfirmDialog
          open={remove}
          onClose={() => setRemove(false)}
          title="删除渠道？"
          detail="只删除此渠道配置，现有聊天和存档保留。"
          onConfirm={async () => {
            await db.channels.delete(channel.id)
            const s = await db.settings.get('app')
            if (s?.activeChannelId === channel.id)
              await db.settings.update('app', { activeChannelId: '' })
          }}
        />
      </CardContent>
    </Card>
  )
}
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
  const [selectedId, setSelectedId] = useState('')
  const [testingAll, setTestingAll] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const selected =
    channels.find((c) => c.id === selectedId) ??
    channels.find((c) => c.id === settings.activeChannelId) ??
    channels[0]
  const testAll = async () => {
    setTestingAll(true)
    controller.current = new AbortController()
    for (const channel of channels) {
      if (controller.current.signal.aborted) break
      try {
        await db.channels.update(channel.id, {
          capability: await testChannel(channel, controller.current.signal),
        })
      } catch (e) {
        await db.channels.update(channel.id, {
          capability: { fingerprint: '', testedAt: Date.now(), ok: false, error: friendlyError(e) },
        })
      }
    }
    setTestingAll(false)
    notify('渠道测试已结束，结果显示在各渠道配置中。')
  }
  useEffect(() => () => controller.current?.abort(), [])
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          controller.current?.abort()
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
          <Button
            disabled={disabled || testingAll}
            onClick={() => {
              const c = newChannel()
              void db.channels.add(c)
              setSelectedId(c.id)
            }}
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
              onClick={() => void testAll()}
            >
              测试全部
            </Button>
          )}
        </div>
        <div className="grid gap-4 md:grid-cols-[1fr_2fr]">
          <nav aria-label="渠道列表" className="flex flex-col gap-2">
            {channels.map((c) => (
              <Button
                key={c.id}
                variant={selected?.id === c.id ? 'secondary' : 'ghost'}
                className="justify-start overflow-hidden"
                disabled={testingAll}
                onClick={() => setSelectedId(c.id)}
              >
                {channelIsReady(c) && <Check />}
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
              disabled={disabled || testingAll}
              onUse={() => {
                void db.settings.update('app', { activeChannelId: selected.id })
                notify(`已切换到 ${selected.name}`)
              }}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function PersonaEditor({
  persona,
  active,
  notify,
  disabled,
}: {
  persona: Persona
  active: boolean
  notify: Notify
  disabled: boolean
}) {
  const [draft, setDraft] = useState(persona)
  const [remove, setRemove] = useState(false)
  const update = (key: keyof Persona, value: string) => setDraft((d) => ({ ...d, [key]: value }))
  return (
    <Card>
      <CardHeader>
        <CardTitle>{draft.name}</CardTitle>
        <CardDescription>
          {active ? '当前人设 · 每轮都会发送给模型' : '保存后可设为当前人设'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <fieldset disabled={disabled} className="flex flex-col gap-5">
          <FieldGroup>
            <FormField label="姓名" value={draft.name} onChange={(v) => update('name', v)} />
            <FormField label="性别" value={draft.gender} onChange={(v) => update('gender', v)} />
            <FormField
              label="身份"
              value={draft.identity}
              onChange={(v) => update('identity', v)}
            />
            <FormField
              label="喜好"
              value={draft.prefer}
              onChange={(v) => update('prefer', v)}
              multiline
            />
            <FormField
              label="强制指令"
              value={draft.force}
              onChange={(v) => update('force', v)}
              multiline
              help="每一轮均注入到角色设定，控制你的人设与叙事规则。"
            />
          </FieldGroup>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => {
                if (!draft.name.trim()) {
                  notify('姓名不能为空。', true)
                  return
                }
                void db.personas.put(draft).then(() => notify('人设已保存。'))
              }}
            >
              保存人设
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                if (!draft.name.trim()) return
                void db.personas
                  .put(draft)
                  .then(() => db.settings.update('app', { activePersonaId: persona.id }))
                  .then(() => notify('当前人设已更新。'))
              }}
            >
              使用此人设
            </Button>
            <IconButton label="删除人设" variant="destructive" onClick={() => setRemove(true)}>
              <Trash2 />
            </IconButton>
          </div>
        </fieldset>
        <ConfirmDialog
          open={remove}
          onClose={() => setRemove(false)}
          title="删除人设？"
          detail="聊天记录会保留，可以重新创建人设。"
          onConfirm={async () => {
            await db.personas.delete(persona.id)
            const s = await db.settings.get('app')
            if (s?.activePersonaId === persona.id)
              await db.settings.update('app', { activePersonaId: '' })
          }}
        />
      </CardContent>
    </Card>
  )
}
export function PersonasDialog({
  open,
  onClose,
  personas,
  settings,
  notify,
  disabled,
}: {
  open: boolean
  onClose: () => void
  personas: Persona[]
  settings: Settings
  notify: Notify
  disabled: boolean
}) {
  const [id, setId] = useState('')
  const selected =
    personas.find((p) => p.id === id) ??
    personas.find((p) => p.id === settings.activePersonaId) ??
    personas[0]
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:page-width">
        <DialogHeader>
          <DialogTitle>人设管理</DialogTitle>
          <DialogDescription>你的姓名、身份、喜好与每轮强制指令。</DialogDescription>
        </DialogHeader>
        <Button
          className="w-fit"
          disabled={disabled}
          onClick={() => {
            const p = newPersona()
            void db.personas.add(p)
            setId(p.id)
          }}
        >
          <Plus />
          新建人设
        </Button>
        <div className="grid gap-4 md:grid-cols-[1fr_2fr]">
          <nav className="flex flex-col gap-2" aria-label="人设列表">
            {personas.map((p) => (
              <Button
                key={p.id}
                variant={selected?.id === p.id ? 'secondary' : 'ghost'}
                className="justify-start"
                onClick={() => setId(p.id)}
              >
                {p.id === settings.activePersonaId && <Check />}
                {p.name}
              </Button>
            ))}
          </nav>
          {selected && (
            <PersonaEditor
              key={selected.id}
              persona={selected}
              active={settings.activePersonaId === selected.id}
              notify={notify}
              disabled={disabled}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function AppearanceDialog({
  open,
  onClose,
  settings,
  notify,
}: {
  open: boolean
  onClose: () => void
  settings: Settings
  notify: Notify
}) {
  const update = (key: keyof Settings, value: string | number) =>
    void db.settings.update('app', { [key]: value })
  const upload = async (file: File | undefined) => {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      notify('请选择图片文件。', true)
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') update('bgImage', reader.result)
    }
    reader.onerror = () => notify('图片读取失败，请重试。', true)
    reader.readAsDataURL(file)
  }
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>外观设置</DialogTitle>
          <DialogDescription>
            字体、背景和透明度会应用到整个界面的共享设计 Token。
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <FormField
            label="聊天字号"
            type="number"
            min={12}
            max={24}
            value={settings.fontChat}
            onChange={(v) => update('fontChat', Math.min(24, Math.max(12, Number(v))))}
          />
          <FormField
            label="界面字号"
            type="number"
            min={12}
            max={18}
            value={settings.fontUi}
            onChange={(v) => update('fontUi', Math.min(18, Math.max(12, Number(v))))}
          />
          <Field>
            <FieldLabel htmlFor="font-family">字体</FieldLabel>
            <Select value={settings.fontFamily} onValueChange={(v) => update('fontFamily', v)}>
              <SelectTrigger id="font-family" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[
                  ['Noto Serif SC', '思源宋体'],
                  ['Noto Serif TC', '思源宋体繁体'],
                  ['system-ui', '系统字体'],
                  ['KaiTi', '楷体'],
                ].map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="background-file">背景图片</FieldLabel>
            <Input
              id="background-file"
              type="file"
              accept="image/*"
              onChange={(e) => void upload(e.target.files?.[0])}
            />
            <FieldDescription>保存到当前浏览器，导出存档时一并保存。</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="background-opacity">背景透明度 · {settings.bgOpacity}%</FieldLabel>
            <Input
              id="background-opacity"
              type="range"
              min={0}
              max={100}
              value={settings.bgOpacity}
              onChange={(e) => update('bgOpacity', Number(e.target.value))}
            />
          </Field>
        </FieldGroup>
        <Button variant="outline" onClick={() => update('bgImage', '')}>
          移除背景
        </Button>
      </DialogContent>
    </Dialog>
  )
}

export function ArchivesSheet({
  open,
  onClose,
  archives,
  activeId,
  onSelect,
  notify,
  disabled,
}: {
  open: boolean
  onClose: () => void
  archives: Archive[]
  activeId: string
  onSelect: (id: string) => void
  notify: Notify
  disabled: boolean
}) {
  const [removeId, setRemoveId] = useState('')
  const [renameId, setRenameId] = useState('')
  const [name, setName] = useState('')
  const [pendingImport, setPendingImport] = useState<unknown>(null)
  const storage = useSyncExternalStore(db.persistence.subscribe, db.persistence.getStatus)
  const importRef = useRef<HTMLInputElement>(null)
  const download = async () => {
    try {
      const data = await exportSave()
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      )
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `盐焗-v2-${new Date().toISOString().slice(0, 10)}.json`
      anchor.click()
      URL.revokeObjectURL(url)
      notify('全部存档、人设、渠道和外观已导出。')
    } catch (e) {
      notify(friendlyError(e), true)
    }
  }
  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full sm:panel-width">
        <SheetHeader>
          <SheetTitle>存档</SheetTitle>
          <SheetDescription>
            每个篇章独立保存完整聊天与压缩摘要。
            <span className="block" role={storage.phase === 'error' ? 'alert' : 'status'}>
              {storage.phase === 'saved'
                ? storage.persistent
                  ? '已同步 OPFS 存档 · 已获准持久保存'
                  : '已同步 OPFS 存档 · 可导出备份'
                : storage.phase === 'error'
                  ? `OPFS 同步失败：${storage.error}。资料保留在浏览器数据库中，可导出或重试。`
                  : storage.phase === 'unavailable'
                    ? '当前浏览器不支持 OPFS，资料已使用浏览器数据库保存。'
                    : '正在同步 OPFS 存档…'}
            </span>
          </SheetDescription>
          {storage.phase === 'error' && (
            <Button variant="outline" onClick={() => void db.persistence.flush()}>
              重试存档同步
            </Button>
          )}
        </SheetHeader>
        <div className="flex flex-wrap gap-2 px-4">
          <Button
            disabled={disabled}
            onClick={() =>
              void createArchive().then((a) => {
                onSelect(a.id)
                onClose()
              })
            }
          >
            <Plus />
            新建
          </Button>
          <Button variant="outline" onClick={() => void download()}>
            <Download />
            导出全部
          </Button>
          <Button variant="outline" disabled={disabled} onClick={() => importRef.current?.click()}>
            <Upload />
            导入
          </Button>
          <input
            ref={importRef}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            aria-label="导入存档文件"
            onChange={async (e) => {
              const file = e.target.files?.[0]
              if (!file) return
              try {
                const value: unknown = JSON.parse(await file.text())
                normalizeImport(value)
                setPendingImport(value)
              } catch (err) {
                notify(friendlyError(err), true)
              }
              e.target.value = ''
            }}
          />
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          {archives.map((a) => (
            <Card key={a.id} size="sm">
              <CardHeader>
                <CardTitle>{a.name}</CardTitle>
                <CardDescription>
                  {formatDate(a.updatedAt)}
                  {a.summary && ' · 已压缩上下文'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap items-center gap-1">
                  <Button
                    disabled={disabled}
                    variant={a.id === activeId ? 'secondary' : 'outline'}
                    onClick={() => {
                      onSelect(a.id)
                      onClose()
                    }}
                  >
                    {a.id === activeId ? '当前存档' : '载入'}
                  </Button>
                  <IconButton
                    label={`重命名 ${a.name}`}
                    disabled={disabled}
                    onClick={() => {
                      setRenameId(a.id)
                      setName(a.name)
                    }}
                  >
                    <PenLine />
                  </IconButton>
                  <IconButton
                    label={`删除 ${a.name}`}
                    disabled={disabled}
                    variant="destructive"
                    onClick={() => setRemoveId(a.id)}
                  >
                    <Trash2 />
                  </IconButton>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
        <ConfirmDialog
          open={!!removeId}
          onClose={() => setRemoveId('')}
          title="删除存档？"
          detail="将删除这个篇章的全部消息和摘要。建议先导出。"
          onConfirm={async () => {
            await db.transaction('rw', db.messages, db.archives, async () => {
              await db.messages.where('archiveId').equals(removeId).delete()
              await db.archives.delete(removeId)
            })
            const next = await db.archives.toCollection().first()
            if (removeId === activeId) onSelect(next?.id || (await createArchive()).id)
          }}
        />
        <Dialog open={!!renameId} onOpenChange={(v) => !v && setRenameId('')}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>重命名存档</DialogTitle>
              <DialogDescription>为这个篇章取一个名字。</DialogDescription>
            </DialogHeader>
            <FormField label="存档名称" value={name} onChange={setName} />
            <Button
              disabled={!name.trim()}
              onClick={() => {
                void db.archives.update(renameId, { name: name.trim() })
                setRenameId('')
              }}
            >
              保存名称
            </Button>
          </DialogContent>
        </Dialog>
        <ConfirmDialog
          open={pendingImport !== null}
          onClose={() => setPendingImport(null)}
          title="导入并替换当前资料？"
          detail="已经校验文件。导入会替换当前浏览器的全部存档、人设、渠道和设置；可先取消并导出。"
          onConfirm={async () => {
            try {
              const data = await importSave(pendingImport)
              await initializeStorage()
              await db.persistence.flush()
              onSelect(data.settings.activeArchiveId || (await createArchive()).id)
              notify('存档导入完成。渠道须重新测试。')
              onClose()
            } catch (e) {
              notify(friendlyError(e), true)
            }
          }}
        />
      </SheetContent>
    </Sheet>
  )
}
