import { ConfirmDialog, FormField, IconButton } from '@/components/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { channelFingerprint, protocolLabels } from '@/lib/channels'
import { formatDate } from '@/lib/format-date'
import type { Notify } from '@/lib/notify'
import {
  channelIsReady,
  channelValidationErrors,
  friendlyError,
  testChannel,
  testChannelProtocols,
} from '@/lib/provider'
import { commitChannelCapability, db } from '@/lib/storage'
import { type ApiMode, type ApiProtocol, type Channel, type ChannelCapability } from '@/lib/types'
import { Check, Eye, EyeOff, FlaskConical, LoaderCircle, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

export function ChannelEditor({
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
