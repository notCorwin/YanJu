import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  db,
  createArchive,
  exportSave,
  exportArchive,
  importSave,
  initializeStorage,
  normalizeImport,
  commitChannelCapability,
} from '@/lib/db'
import { downloadJson, saveFileName } from '@/lib/download'
import { withArchiveOperation } from '@/lib/operations'
import {
  channelIsReady,
  friendlyError,
  testChannel,
  testChannelProtocols,
  channelValidationErrors,
} from '@/lib/provider'
import { channelFingerprint, protocolLabels } from '@/lib/channels'
import {
  newChannel,
  newPersona,
  type ApiMode,
  type ApiProtocol,
  type Archive,
  type Channel,
  type ChannelCapability,
  type Persona,
  type Settings,
} from '@/lib/types'
import { Button } from './ui/button'
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from './ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from './ui/sheet'
import { FieldGroup, Field, FieldLabel, FieldDescription } from './ui/field'
import { Input } from './ui/input'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from './ui/select'
import { Badge } from './ui/badge'
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyMedia } from './ui/empty'
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
  Eye,
  EyeOff,
  SlidersHorizontal,
  VenetianMask,
} from 'lucide-react'

export type Notify = (message: string, error?: boolean) => void
const formatDate = (value: number) => new Date(value).toLocaleString('zh-CN', { hour12: false })

function ChannelEditor({
  channel,
  active,
  notify,
  onUse,
  disabled,
  onDirtyChange,
}: {
  channel: Channel
  active: boolean
  notify: Notify
  onUse: (channel: Channel) => Promise<void>
  disabled: boolean
  onDirtyChange: (dirty: boolean) => void
}) {
  const [draft, setDraft] = useState<
    Omit<Channel, 'temperature' | 'maxOutputTokens' | 'contextWindow'> & {
      temperature: number | string | null
      maxOutputTokens: number | string
      contextWindow: number | string
    }
  >(channel)
  const [errors, setErrors] = useState<Partial<Record<keyof Channel, string>>>({})
  const [saving, setSaving] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  const value: Channel = {
    ...draft,
    temperature: draft.temperature === null ? null : Number(draft.temperature),
    maxOutputTokens: Number(draft.maxOutputTokens),
    contextWindow: Number(draft.contextWindow),
  }
  const dirty =
    JSON.stringify({ ...draft, capability: undefined, calibration: undefined }) !==
    JSON.stringify({ ...channel, capability: undefined, calibration: undefined })
  useEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [remove, setRemove] = useState(false)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  const update = (key: keyof Channel, value: string | number | null) => {
    setErrors((previous) => ({ ...previous, [key]: undefined }))
    setDraft((d) => ({
      ...d,
      [key]: value,
      capability: key === 'name' ? d.capability : undefined,
      calibration: key === 'name' ? d.calibration : undefined,
    }))
  }
  const validated = () => {
    const next = {
      ...value,
      name: value.name.trim(),
      baseUrl: value.baseUrl.trim(),
      apiKey: value.apiKey.trim(),
      model: value.model.trim(),
    }
    const issues = channelValidationErrors(next)
    setErrors(issues)
    if (Object.keys(issues).length) {
      requestAnimationFrame(() =>
        formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      )
      return undefined
    }
    return next
  }
  const save = async (showFeedback = true) => {
    const next = validated()
    if (!next) return
    setSaving(true)
    try {
      await db.channels.put(next)
      setDraft(next)
      if (showFeedback)
        notify(
          channelIsReady(next)
            ? '渠道已保存，可以继续聊天。'
            : '渠道已保存；通过测试后可用于聊天。',
        )
      return next
    } catch (e) {
      notify(friendlyError(e), true)
    } finally {
      setSaving(false)
    }
  }
  const test = async (full = false) => {
    const candidate = validated()
    if (!candidate) return
    controller.current = new AbortController()
    setBusy(true)
    setProgress(full ? '正在检查完整协议…' : '正在检查连接与流式传输…')
    try {
      await db.channels.put(candidate)
      setDraft(candidate)
      const capability = full
        ? await testChannelProtocols(candidate, controller.current.signal, setProgress)
        : await testChannel(candidate, controller.current.signal, undefined, setProgress)
      const next = await commitChannelCapability(candidate, capability)
      if (!next) {
        const current = await db.channels.get(draft.id)
        if (current) setDraft(current)
        notify('渠道配置已在其他窗口变更或删除，旧测试结果未保存。请重新测试。', true)
        return
      }
      setDraft(next)
      notify(
        capability.ok
          ? full
            ? '完整叙事、论坛和压缩协议测试通过。'
            : `渠道测试通过，使用 ${protocolLabels[capability.protocol!]}。`
          : (capability.error ?? '渠道测试未通过。'),
        !capability.ok,
      )
    } catch (e) {
      if (controller.current.signal.aborted) {
        notify(
          channelIsReady(value)
            ? '渠道测试已取消，原测试结果已保留。'
            : '渠道测试已取消，须完成测试后使用此配置。',
        )
        return
      }
      const error = friendlyError(e)
      const capability: ChannelCapability =
        full && channelIsReady(candidate)
          ? { ...candidate.capability!, protocols: false, error }
          : { fingerprint: channelFingerprint(candidate), testedAt: Date.now(), ok: false, error }
      const next = await commitChannelCapability(candidate, capability)
      if (next) setDraft(next)
      notify(error, true)
    } finally {
      setBusy(false)
      setProgress('')
    }
  }
  return (
    <form
      ref={formRef}
      noValidate
      className="flex min-h-0 min-w-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault()
        if (!busy && !saving && !disabled) void save()
      }}
    >
      <Card className="min-h-0 flex-1">
        <CardHeader className="compact-height:hidden">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>{draft.name.trim() || '未命名渠道'}</CardTitle>
            {active && <Badge>当前渠道</Badge>}
          </div>
          <CardDescription>填写服务商提供的连接信息，测试通过后即可开始聊天。</CardDescription>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-4">
          <fieldset disabled={busy || saving || disabled} className="flex min-w-0 flex-col gap-5">
            <FieldGroup>
              <FormField
                label="渠道名称"
                name="name"
                error={errors.name}
                value={draft.name}
                onChange={(v) => update('name', v)}
                autoComplete="off"
              />
              <FormField
                label="Base URL"
                name="baseUrl"
                error={errors.baseUrl}
                value={draft.baseUrl}
                onChange={(v) => update('baseUrl', v)}
                placeholder="https://example.com/v1"
                type="url"
                help="填写 API 根地址（通常以 /v1 结尾），不含 /responses 或 /chat/completions。"
                autoComplete="url"
              />
              <FormField
                label="API Key"
                name="apiKey"
                error={errors.apiKey}
                value={draft.apiKey}
                onChange={(v) => update('apiKey', v)}
                type={showKey ? 'text' : 'password'}
                endAddon={
                  <IconButton
                    type="button"
                    label={showKey ? '隐藏 Key' : '显示 Key'}
                    aria-pressed={showKey}
                    onClick={() => setShowKey((visible) => !visible)}
                  >
                    {showKey ? <EyeOff /> : <Eye />}
                  </IconButton>
                }
                autoComplete="off"
              />
              <FormField
                label="模型"
                name="model"
                error={errors.model}
                value={draft.model}
                onChange={(v) => update('model', v)}
                placeholder="填写渠道提供的模型 ID"
                autoComplete="off"
              />
              <Field>
                <FieldLabel htmlFor={`api-mode-${draft.id}`}>API 协议</FieldLabel>
                <Select
                  value={draft.apiMode}
                  disabled={busy || saving || disabled}
                  onValueChange={(value) => update('apiMode', value as ApiMode)}
                >
                  <SelectTrigger id={`api-mode-${draft.id}`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="auto">自动探测（Responses 优先）</SelectItem>
                      <SelectItem value="responses">Responses</SelectItem>
                      <SelectItem value="chat-completions">Chat Completions</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  自动测试两种协议的非流式和流式严格输出，最多发送 4
                  个短请求。正式生成使用测试选定的协议。
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor={`temperature-mode-${draft.id}`}>温度设置</FieldLabel>
                <Select
                  value={draft.temperature === null ? 'default' : 'custom'}
                  disabled={busy || saving || disabled}
                  onValueChange={(value) => update('temperature', value === 'default' ? null : 0.9)}
                >
                  <SelectTrigger id={`temperature-mode-${draft.id}`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="default">模型默认</SelectItem>
                      <SelectItem value="custom">自定义温度</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  模型默认会省略温度参数，适用于不接受自定义温度的模型。
                </FieldDescription>
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                {draft.temperature !== null && (
                  <FormField
                    label="温度"
                    name="temperature"
                    error={errors.temperature}
                    type="number"
                    min={0}
                    max={2}
                    step={0.1}
                    value={draft.temperature}
                    onChange={(v) => update('temperature', v)}
                  />
                )}
                <FormField
                  label="输出上限（tokens）"
                  name="maxOutputTokens"
                  error={errors.maxOutputTokens}
                  type="number"
                  min={128}
                  step={128}
                  value={draft.maxOutputTokens}
                  onChange={(v) => update('maxOutputTokens', v)}
                />
              </div>
              <FormField
                label="上下文容量（tokens）"
                name="contextWindow"
                error={errors.contextWindow}
                value={draft.contextWindow}
                onChange={(v) => update('contextWindow', v)}
                type="number"
                min={1024}
                step={1024}
                help="默认 32,768；按模型实际容量填写。输入占用达到 85% 或输出空间不足时自动压缩。"
              />
              <FormField
                label="请求等待上限（秒）"
                name="requestTimeoutMs"
                error={errors.requestTimeoutMs}
                type="number"
                min={0}
                value={(draft.requestTimeoutMs ?? 300000) / 1000}
                onChange={(v) => update('requestTimeoutMs', Number(v) * 1000)}
                help="限制首个内容和后续内容的等待时间；持续返回内容的长回复可继续生成。0 表示不限。"
              />
            </FieldGroup>
          </fieldset>
          {busy && (
            <div className="mt-3 flex flex-col gap-2" role="status">
              <span>{progress || '正在测试…'}</span>
            </div>
          )}

          {draft.capability?.ok && (
            <p className="mt-3 text-sm text-success">
              测试通过 · {draft.capability.protocols ? '完整协议' : '连接、结构化与流式'} ·{' '}
              {formatDate(draft.capability.testedAt)}
              {' · 当前协议：'}
              {draft.capability.protocol && protocolLabels[draft.capability.protocol]}
            </p>
          )}
          {draft.capability?.checks && (
            <div className="mt-3 flex flex-col gap-2" aria-label="协议测试结果">
              {(['responses', 'chat-completions'] as ApiProtocol[]).map((protocol) => {
                const check = draft.capability?.checks?.[protocol]
                if (!check) return null
                const labels = { passed: '通过', failed: '失败', untested: '未测试' }
                return (
                  <div key={protocol} className="text-sm">
                    <p>
                      {protocolLabels[protocol]} · 非流式：{labels[check.nonStreaming]} · 流式：
                      {labels[check.streaming]}
                    </p>
                    {check.error && (
                      <p className="wrap-break-word text-muted-foreground">{check.error}</p>
                    )}
                  </div>
                )
              })}
            </div>
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
        <CardFooter className="shrink-0 flex-wrap gap-2">
          <Button type="submit" disabled={busy || saving || disabled}>
            {saving && <LoaderCircle data-icon="inline-start" className="animate-spin" />}
            保存渠道
          </Button>
          {busy ? (
            <Button type="button" variant="outline" onClick={() => controller.current?.abort()}>
              <LoaderCircle data-icon="inline-start" className="animate-spin" />
              取消测试
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              disabled={saving || disabled}
              onClick={() => void test()}
            >
              <FlaskConical data-icon="inline-start" />
              测试渠道
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={busy || saving || disabled}
            onClick={() => void test(true)}
          >
            完整协议测试
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={busy || saving || disabled || !channelIsReady(value)}
            onClick={async () => {
              const saved = await save(false)
              if (saved) {
                try {
                  await onUse(saved)
                } catch (error) {
                  notify(friendlyError(error), true)
                }
              }
            }}
          >
            <Check data-icon="inline-start" />
            使用此渠道
          </Button>
          <IconButton
            type="button"
            label="删除渠道"
            disabled={busy || saving || disabled}
            variant="ghost"
            onClick={() => setRemove(true)}
          >
            <Trash2 />
          </IconButton>
        </CardFooter>
      </Card>
    </form>
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
  const [dirty, setDirty] = useState(false)
  const { guard, confirmation } = useUnsavedChanges(dirty)
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
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          guard(() => {
            controller.current?.abort()
            onClose()
          })
        }
      }}
    >
      <DialogContent size="wide" className="editor-height overflow-hidden compact-height:gap-2">
        <DialogHeader>
          <DialogTitle>渠道管理</DialogTitle>
          <DialogDescription className="compact-height:hidden">
            保存多个服务商配置，通过测试后可以随时切换。
          </DialogDescription>
        </DialogHeader>
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
                  点击「新建渠道」，填写服务商提供的地址、Key 和模型。通过测试后即可开始聊天。
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
      </DialogContent>
      <ConfirmDialog
        {...confirmation}
        title="放弃未保存的修改？"
        detail="修改还没有保存。可以取消返回编辑，或放弃修改后继续。"
        confirmLabel="放弃修改"
        destructive={false}
      />
    </Dialog>
  )
}

function PersonaEditor({
  persona,
  active,
  notify,
  disabled,
  onDirtyChange,
}: {
  persona: Persona
  active: boolean
  notify: Notify
  disabled: boolean
  onDirtyChange: (dirty: boolean) => void
}) {
  const [draft, setDraft] = useState(persona)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  const dirty = JSON.stringify(draft) !== JSON.stringify(persona)
  useEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])
  const save = async (usePersona = false) => {
    if (!draft.name.trim()) {
      setError('请输入人设姓名。')
      formRef.current?.querySelector<HTMLInputElement>('input')?.focus()
      return
    }
    setSaving(true)
    try {
      const value = {
        ...draft,
        name: draft.name.trim(),
        gender: draft.gender.trim(),
        identity: draft.identity.trim(),
        prefer: draft.prefer.trim(),
        force: draft.force.trim(),
      }
      await db.personas.put(value)
      if (usePersona) await db.settings.update('app', { activePersonaId: persona.id })
      setDraft(value)
      notify(usePersona ? '当前人设已更新。' : '人设已保存。')
    } catch (e) {
      notify(friendlyError(e), true)
    } finally {
      setSaving(false)
    }
  }
  const [remove, setRemove] = useState(false)
  const update = (key: keyof Persona, value: string) => {
    setError('')
    setDraft((d) => ({ ...d, [key]: value }))
  }
  return (
    <form
      ref={formRef}
      className="flex min-h-0 min-w-0 flex-col"
      onSubmit={(e) => {
        e.preventDefault()
        if (!saving && !disabled) void save()
      }}
    >
      <Card className="min-h-0 flex-1">
        <CardHeader className="compact-height:hidden">
          <CardTitle>{draft.name.trim() || '未命名人设'}</CardTitle>
          <CardDescription>
            {active ? '当前人设 · 每轮都会发送给模型' : '保存后可设为当前人设'}
          </CardDescription>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-4">
          <fieldset disabled={disabled || saving} className="flex flex-col gap-5">
            <FieldGroup>
              <FormField
                name="name"
                error={error}
                label="姓名"
                value={draft.name}
                onChange={(v) => update('name', v)}
              />
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
        <CardFooter className="shrink-0 flex-wrap gap-2">
          <Button type="submit" disabled={disabled || saving}>
            {saving && <LoaderCircle data-icon="inline-start" className="animate-spin" />}保存人设
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={disabled || saving}
            onClick={() => void save(true)}
          >
            使用此人设
          </Button>
          <IconButton
            type="button"
            label="删除人设"
            variant="ghost"
            disabled={disabled || saving}
            onClick={() => setRemove(true)}
          >
            <Trash2 />
          </IconButton>
        </CardFooter>
      </Card>
    </form>
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
  const [dirty, setDirty] = useState(false)
  const { guard, confirmation } = useUnsavedChanges(dirty)
  const selected =
    personas.find((p) => p.id === id) ??
    personas.find((p) => p.id === settings.activePersonaId) ??
    personas[0]
  return (
    <Dialog open={open} onOpenChange={(v) => !v && guard(onClose)}>
      <DialogContent size="wide" className="editor-height overflow-hidden compact-height:gap-2">
        <DialogHeader>
          <DialogTitle>人设管理</DialogTitle>
          <DialogDescription className="compact-height:hidden">
            你的姓名、身份、喜好与每轮强制指令。
          </DialogDescription>
        </DialogHeader>
        <Button
          className="w-fit"
          disabled={disabled}
          onClick={() =>
            guard(() => {
              const p = newPersona()
              void db.personas
                .add(p)
                .then(() => setId(p.id))
                .catch((e) => notify(friendlyError(e), true))
            })
          }
        >
          <Plus />
          新建人设
        </Button>
        <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-4 md:grid-cols-[1fr_2fr] md:grid-rows-1">
          <nav
            className="flex min-w-0 gap-2 overflow-x-auto pb-1 md:flex-col md:overflow-y-auto"
            aria-label="人设列表"
          >
            {personas.map((p) => (
              <Button
                key={p.id}
                variant={selected?.id === p.id ? 'secondary' : 'ghost'}
                className="min-w-0 justify-start overflow-hidden"
                aria-current={selected?.id === p.id ? 'true' : undefined}
                onClick={() => selected?.id !== p.id && guard(() => setId(p.id))}
              >
                {p.id === settings.activePersonaId && <Check />}
                <span className="truncate">{p.name}</span>
              </Button>
            ))}
          </nav>
          {!selected && (
            <Empty className="md:col-span-2">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <VenetianMask />
                </EmptyMedia>
                <EmptyTitle>你想成为谁？</EmptyTitle>
                <EmptyDescription>
                  点击「新建人设」，为故事中的自己填写姓名、身份和喜好。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          {selected && (
            <PersonaEditor
              key={selected.id}
              persona={selected}
              onDirtyChange={setDirty}
              active={settings.activePersonaId === selected.id}
              notify={notify}
              disabled={disabled}
            />
          )}
        </div>
      </DialogContent>
      <ConfirmDialog
        {...confirmation}
        title="放弃未保存的修改？"
        detail="修改还没有保存。可以取消返回编辑，或放弃修改后继续。"
        confirmLabel="放弃修改"
        destructive={false}
      />
    </Dialog>
  )
}

function AppearanceNumberField({
  label,
  value,
  max,
  onChange,
}: {
  label: string
  value: number
  max: number
  onChange: (value: number) => void
}) {
  const id = label === '聊天字号' ? 'font-chat' : 'font-ui'
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label} · 像素</FieldLabel>
      <Input
        id={id}
        name={id}
        type="number"
        min={12}
        max={max}
        defaultValue={value}
        onChange={(e) => {
          const n = e.target.valueAsNumber
          if (Number.isFinite(n) && n >= 12 && n <= max) onChange(n)
        }}
        onBlur={(e) => {
          const n = e.target.valueAsNumber
          const next = Number.isFinite(n) ? Math.min(max, Math.max(12, n)) : value
          e.target.value = String(next)
          onChange(next)
        }}
      />
      <FieldDescription>可选 12–{max}，更改即时预览并自动保存。</FieldDescription>
    </Field>
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
    void db.settings.update('app', { [key]: value }).catch((e) => notify(friendlyError(e), true))
  const [savingBackground, setSavingBackground] = useState(false)
  const saving = useRef(false)
  const saveBackground = async (file?: File) => {
    if (saving.current) return
    saving.current = true
    setSavingBackground(true)
    try {
      await replaceBackground(db, file)
    } catch (error) {
      notify(friendlyError(error), true)
    } finally {
      saving.current = false
      setSavingBackground(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>外观设置</DialogTitle>
          <DialogDescription>调整阅读字号、界面字体与背景。更改会自动保存。</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <AppearanceNumberField
            label="聊天字号"
            value={settings.fontChat}
            max={24}
            onChange={(value) => update('fontChat', value)}
          />
          <AppearanceNumberField
            label="界面字号"
            value={settings.fontUi}
            max={18}
            onChange={(value) => update('fontUi', value)}
          />
          <Field>
            <FieldLabel htmlFor="font-family">字体</FieldLabel>
            <Select value={settings.fontFamily} onValueChange={(v) => update('fontFamily', v)}>
              <SelectTrigger id="font-family" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
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
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="background-file">背景图片</FieldLabel>
            <Input
              id="background-file"
              type="file"
              accept="image/*"
              disabled={savingBackground}
              aria-busy={savingBackground}
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) void saveBackground(file)
              }}
            />
            <FieldDescription role={savingBackground ? 'status' : undefined}>
              {savingBackground ? '正在保存背景图片…' : '保存到当前浏览器，导出存档时一并保存。'}
            </FieldDescription>
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
        <Button
          variant="outline"
          disabled={!settings.bgImage || savingBackground}
          aria-busy={savingBackground}
          onClick={() => void saveBackground()}
        >
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
  const [creating, setCreating] = useState(false)
  const [namePending, setNamePending] = useState(false)
  const [nameError, setNameError] = useState('')
  const [search, setSearch] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)
  const visibleArchives = archives.filter((archive) =>
    archive.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  )
  const [pendingImport, setPendingImport] = useState<unknown>(null)
  const [importMode, setImportMode] = useState<'replace' | 'merge'>('replace')
  const storage = useSyncExternalStore(db.persistence.subscribe, db.persistence.getStatus)
  const importRef = useRef<HTMLInputElement>(null)
  const download = async () => {
    try {
      const data = await exportSave()
      downloadJson(data, saveFileName())
      notify('全部存档、人设、渠道和外观已导出。')
    } catch (e) {
      notify(friendlyError(e), true)
    }
  }
  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full overflow-hidden sm:panel-width safe-bottom">
        <SheetHeader>
          <SheetTitle>存档</SheetTitle>
          <SheetDescription>
            每个篇章独立保存完整聊天与压缩摘要。
            <span className="block" role={storage.phase === 'error' ? 'alert' : 'status'}>
              {storage.phase === 'saved'
                ? storage.persistent
                  ? '全部更改已保存 · 已获准持久保存'
                  : '全部更改已保存 · 可导出备份'
                : storage.phase === 'error'
                  ? `存档备份未完成：${storage.error}。资料保留在浏览器数据库中，可导出或重试。`
                  : storage.phase === 'unavailable'
                    ? '资料已保存在当前浏览器，建议定期导出备份。'
                    : '正在保存更改…'}
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
            onClick={() => {
              setName('新的篇章')
              setNameError('')
              setCreating(true)
            }}
          >
            <Plus />
            新建
          </Button>
          <Button variant="outline" onClick={() => void download()}>
            <Download />
            导出全部
          </Button>
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => {
              setImportMode('replace')
              importRef.current?.click()
            }}
          >
            <Upload />
            导入
          </Button>
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => {
              setImportMode('merge')
              importRef.current?.click()
            }}
          >
            合并导入
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
        <div className="flex flex-col gap-2 px-4">
          <label htmlFor="archive-search" className="sr-only">
            搜索存档
          </label>
          <Input
            id="archive-search"
            type="search"
            placeholder="搜索篇章名称…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <p className="text-xs text-muted-foreground" role="status">
            {search.trim()
              ? `找到 ${visibleArchives.length} 个篇章`
              : `共 ${archives.length} 个篇章`}
          </p>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          {!visibleArchives.length && (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{search.trim() ? '没有找到匹配的篇章' : '还没有保存的篇章'}</EmptyTitle>
                <EmptyDescription>
                  {search.trim()
                    ? '换一个关键词，或查看全部存档。'
                    : '新建篇章开始聊天，也可以导入存档继续。'}
                </EmptyDescription>
              </EmptyHeader>
              {search.trim() && (
                <Button variant="outline" onClick={() => setSearch('')}>
                  查看全部存档
                </Button>
              )}
            </Empty>
          )}
          {visibleArchives.map((a) => (
            <Card key={a.id} size="sm" className="shrink-0">
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
                    label={`导出 ${a.name}`}
                    onClick={() => {
                      void exportArchive(a.id)
                        .then((data) => downloadJson(data, saveFileName(a.name)))
                        .catch((error) => notify(friendlyError(error), true))
                    }}
                  >
                    <Download />
                  </IconButton>
                  <IconButton
                    label={`重命名 ${a.name}`}
                    disabled={disabled}
                    onClick={() => {
                      setRenameId(a.id)
                      setName(a.name)
                      setNameError('')
                    }}
                  >
                    <PenLine />
                  </IconButton>
                  <IconButton
                    label={`删除 ${a.name}`}
                    disabled={disabled}
                    variant="ghost"
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
            await withArchiveOperation(removeId, () =>
              db.transaction(
                'rw',
                [db.messages, db.archives, db.storyStates, db.storyEvents, db.tasks, db.requests],
                async () => {
                  await db.messages.where('archiveId').equals(removeId).delete()
                  await db.archives.delete(removeId)
                  await db.storyStates.delete(removeId)
                  await db.storyEvents.where('archiveId').equals(removeId).delete()
                  await db.tasks.where('archiveId').equals(removeId).delete()
                  await db.requests.where('archiveId').equals(removeId).delete()
                },
              ),
            )
            const next = await db.archives.toCollection().first()
            if (removeId === activeId) onSelect(next?.id || (await createArchive()).id)
          }}
        />
        <Dialog
          open={!!renameId || creating}
          onOpenChange={(v) => {
            if (!v && !namePending) {
              setRenameId('')
              setCreating(false)
            }
          }}
        >
          <DialogContent
            onEscapeKeyDown={(event) => namePending && event.preventDefault()}
            onInteractOutside={(event) => namePending && event.preventDefault()}
          >
            <DialogHeader>
              <DialogTitle>{creating ? '新建篇章' : '重命名存档'}</DialogTitle>
              <DialogDescription>为这个篇章取一个名字，方便下次找到它。</DialogDescription>
            </DialogHeader>
            <form
              className="flex flex-col gap-4"
              onSubmit={async (e) => {
                e.preventDefault()
                if (namePending) return
                if (!name.trim()) {
                  setNameError('请输入存档名称。')
                  nameRef.current?.focus()
                  return
                }
                setNamePending(true)
                try {
                  if (creating) {
                    const archive = await createArchive(name.trim())
                    onSelect(archive.id)
                    setCreating(false)
                    setSearch('')
                    onClose()
                  } else {
                    await withArchiveOperation(renameId, () =>
                      db.archives.update(renameId, { name: name.trim() }),
                    )
                    notify('存档名称已更新。')
                  }
                  setRenameId('')
                } catch (error) {
                  setNameError(friendlyError(error))
                } finally {
                  setNamePending(false)
                }
              }}
            >
              <FormField
                label="存档名称"
                ref={nameRef}
                name="archive-name"
                value={name}
                error={nameError}
                onChange={(value) => {
                  setName(value)
                  setNameError('')
                }}
                disabled={namePending}
                autoFocus
                onFocus={(event) => event.target.select()}
              />
              <Button type="submit" disabled={namePending}>
                {namePending && <LoaderCircle className="animate-spin" />}
                {creating ? '创建并进入聊天' : '保存名称'}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
        <ConfirmDialog
          open={pendingImport !== null}
          onClose={() => setPendingImport(null)}
          title={importMode === 'merge' ? '合并导入存档？' : '导入并替换当前资料？'}
          detail={
            importMode === 'merge'
              ? '已经校验文件。保留现有资料和外观设置；编号冲突的篇章会作为独立副本导入。'
              : '已经校验文件。导入会替换当前浏览器的全部存档、人设、渠道和设置；可先取消并导出。'
          }
          onConfirm={async () => {
            const data = await importSave(pendingImport, db, false, importMode)
            await initializeStorage()
            await db.persistence.flush()
            onSelect(data.settings.activeArchiveId || (await createArchive()).id)
            notify('存档导入完成。渠道须重新测试。')
            onClose()
          }}
        />
      </SheetContent>
    </Sheet>
  )
}
