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
import { SearchableSelect } from '@/components/ui/searchable-select'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  loadModelCatalog,
  modelCatalogProviderId,
  selectCatalogModel,
  type ModelCatalog,
} from '@/lib/model-catalog'
import {
  channelFingerprint,
  protocolLabels,
  endpointLabels,
  outputModeLabels,
} from '@/lib/channels'
import { supportedSdks } from '@/lib/provider-registry'
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
import { apiProtocols, type ApiMode, type Channel, type ChannelCapability } from '@/lib/types'
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
    Omit<Channel, 'temperature'> & { temperature: number | string | null }
  >(channel)
  const [catalog, setCatalog] = useState<ModelCatalog>()
  const [catalogError, setCatalogError] = useState('')
  const [loadingCatalog, setLoadingCatalog] = useState(false)
  const refreshCatalog = async () => {
    setLoadingCatalog(true)
    try {
      setCatalog(await loadModelCatalog(true))
      setCatalogError('')
    } catch (error) {
      setCatalogError(friendlyError(error))
    } finally {
      setLoadingCatalog(false)
    }
  }
  useEffect(() => {
    let mounted = true
    void loadModelCatalog()
      .then((value) => {
        if (mounted) setCatalog(value)
      })
      .catch((error) => {
        if (mounted) setCatalogError(friendlyError(error))
      })
    return () => {
      mounted = false
    }
  }, [])
  const custom = draft.connectionMode === 'custom'
  const provider = catalog?.[modelCatalogProviderId(draft)]
  const selectedModel = provider?.models[draft.model]
  const providers = Object.values(catalog ?? {}).sort((a, b) => a.name.localeCompare(b.name))
  const modelOptions = (custom ? providers : provider ? [provider] : [])
    .flatMap((source) =>
      Object.values(source.models).map((model) => ({
        value: custom ? JSON.stringify([source.id, model.id]) : model.id,
        label: `${model.name} · ${model.id}${custom ? ` · ${source.name}` : ''}`,
        provider: source,
        model,
      })),
    )
    .sort((a, b) => a.label.localeCompare(b.label))
  const [errors, setErrors] = useState<Partial<Record<keyof Channel, string>>>({})
  const [saving, setSaving] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  const value: Channel = {
    ...draft,
    temperature: draft.temperature === null ? null : Number(draft.temperature),
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
    const resolved =
      provider && selectedModel
        ? {
            ...selectCatalogModel(next, provider, selectedModel),
            apiMode: next.apiMode,
            sdk: next.sdk,
            baseUrl: next.baseUrl,
            name: next.name,
          }
        : next
    if (channelFingerprint(resolved) === channelFingerprint(next)) {
      resolved.capability = next.capability
      resolved.calibration = next.calibration
    }
    const issues = channelValidationErrors(resolved)
    if (!custom && !provider) issues.providerId = '请选择 Models.dev 中的 Provider。'
    if (!selectedModel) issues.model = '请选择 Models.dev 中的文本模型。'
    setErrors(issues)
    if (Object.keys(issues).length) {
      requestAnimationFrame(() =>
        formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      )
      return undefined
    }
    return resolved
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
      className="channel-editor-height flex min-h-0 min-w-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault()
        if (!busy && !saving && !disabled && catalog) void save()
      }}
    >
      <Card className="min-h-0 flex-1">
        <CardHeader className="compact-height:hidden">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>{draft.name.trim() || '未命名渠道'}</CardTitle>
            {active && <Badge>当前渠道</Badge>}
          </div>
          <CardDescription>
            选择目录中的服务商或自定义端点，再从 Models.dev 选择模型并测试连接。
          </CardDescription>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-4">
          <fieldset disabled={busy || saving || disabled} className="flex min-w-0 flex-col gap-5">
            <FieldGroup>
              <FormField
                label="渠道名称"
                name="name"
                error={errors.name}
                value={draft.name}
                onChange={(value) => update('name', value)}
                placeholder="例如：日常叙事、长篇创作…"
                autoComplete="off"
              />
              <Field data-invalid={!!(errors.providerId || errors.connectionMode)}>
                <FieldLabel htmlFor={`provider-${draft.id}`}>Provider</FieldLabel>
                <SearchableSelect
                  id={`provider-${draft.id}`}
                  aria-invalid={!!(errors.providerId || errors.connectionMode)}
                  value={custom ? 'custom' : draft.providerId ? `catalog:${draft.providerId}` : ''}
                  disabled={busy || saving || disabled || !catalog}
                  options={[
                    { value: 'custom', label: '自定义端点' },
                    ...providers.map((p) => ({ value: `catalog:${p.id}`, label: p.name })),
                  ]}
                  placeholder={catalog ? '选择服务商或自定义端点' : '正在加载 Models.dev…'}
                  searchLabel="搜索提供商"
                  searchPlaceholder="搜索提供商名称或 ID…"
                  emptyMessage="未找到匹配的提供商。"
                  onValueChange={(id) => {
                    if (id === 'custom') {
                      const next: Channel = {
                        ...value,
                        connectionMode: 'custom',
                        providerId: '',
                        modelProviderId: modelCatalogProviderId(value),
                        sdk: '@ai-sdk/openai-compatible',
                        apiMode: 'chat-completions',
                        capability: undefined,
                        calibration: undefined,
                      }
                      setDraft(
                        provider && selectedModel
                          ? selectCatalogModel(next, provider, selectedModel)
                          : next,
                      )
                    } else {
                      const next = catalog?.[id.slice('catalog:'.length)]
                      const model =
                        next && (next.models[draft.model] ?? Object.values(next.models)[0])
                      if (next && model)
                        setDraft(
                          selectCatalogModel({ ...value, connectionMode: 'catalog' }, next, model),
                        )
                    }
                    setErrors({})
                  }}
                />
                <FieldDescription>
                  {custom
                    ? '填写服务地址并选择它支持的 API 端点。模型可从整个 Models.dev 目录选择。'
                    : '从 Models.dev 选择服务商，使用其地址与认证方式，也可覆盖 Base URL。'}
                </FieldDescription>
                {(errors.providerId || errors.connectionMode) && (
                  <FieldDescription role="alert">
                    {errors.providerId || errors.connectionMode}
                  </FieldDescription>
                )}
              </Field>
              <Field data-invalid={!!errors.model}>
                <FieldLabel htmlFor={`model-${draft.id}`}>模型</FieldLabel>
                <SearchableSelect
                  id={`model-${draft.id}`}
                  aria-invalid={!!errors.model}
                  value={
                    custom ? JSON.stringify([draft.modelProviderId, draft.model]) : draft.model
                  }
                  disabled={busy || saving || disabled || !catalog || (!custom && !provider)}
                  options={modelOptions}
                  placeholder="选择模型"
                  searchLabel="搜索模型"
                  searchPlaceholder="搜索模型名称或 ID…"
                  emptyMessage="未找到匹配的模型。"
                  onValueChange={(id) => {
                    const option = modelOptions.find((option) => option.value === id)
                    if (option) {
                      setDraft(selectCatalogModel(value, option.provider, option.model))
                      setErrors({})
                    }
                  }}
                />
                <FieldDescription>
                  {custom
                    ? '列表中的服务商名称仅标明模型资料来源。请求发送至自定义 Base URL，调用方式由 API 端点决定。'
                    : '所有支持文本输入与输出的模型均可选择。'}
                  {selectedModel &&
                    `上下文 ${selectedModel.limit.context.toLocaleString()} tokens · ${selectedModel.structured_output ? '支持 Structured Outputs' : '自动选择 JSON 输出模式'}`}
                </FieldDescription>
                {errors.model && <FieldDescription role="alert">{errors.model}</FieldDescription>}
              </Field>
              <Button
                type="button"
                variant="outline"
                disabled={loadingCatalog || busy || saving || disabled}
                onClick={() => void refreshCatalog()}
              >
                {loadingCatalog && (
                  <LoaderCircle data-icon="inline-start" className="animate-spin" />
                )}
                刷新模型目录
              </Button>
              {catalogError && (
                <p role="alert" className="text-sm text-destructive">
                  {catalogError}
                </p>
              )}
              <FormField
                label="API Key"
                help={
                  custom
                    ? draft.apiMode === 'native'
                      ? '使用所选 SDK 的凭据；云服务可粘贴包含认证字段的完整 JSON。'
                      : undefined
                    : provider &&
                        (provider.env.length > 1 ||
                          provider.npm.startsWith('@ai-sdk/google-vertex'))
                      ? `云服务可在此粘贴完整凭据 JSON，包含 Models.dev 所列认证字段：${provider.env.join('、')}。详见服务商凭据文档。`
                      : undefined
                }
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
                label={custom ? 'Base URL' : 'Base URL（可选）'}
                name="baseUrl"
                error={errors.baseUrl}
                value={draft.baseUrl}
                placeholder={
                  custom
                    ? 'https://example.com/v1'
                    : (selectedModel?.provider?.api ?? provider?.api ?? '使用 Provider 默认地址')
                }
                help={
                  custom
                    ? '填写此服务的地址、API 前缀或完整端点。'
                    : '留空使用 Models.dev 或官方 SDK 的默认地址；可填写 API 前缀或完整端点地址。'
                }
                onChange={(v) => update('baseUrl', v)}
                autoComplete="off"
              />
              <Field data-invalid={!!errors.apiMode}>
                <FieldLabel htmlFor={`api-mode-${draft.id}`}>API 端点</FieldLabel>
                <Select
                  value={draft.apiMode}
                  disabled={busy || saving || disabled}
                  onValueChange={(v) => update('apiMode', v as ApiMode)}
                >
                  <SelectTrigger
                    id={`api-mode-${draft.id}`}
                    className="w-full"
                    aria-invalid={!!errors.apiMode}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="auto">自动探测（Responses / Chat Completions）</SelectItem>
                      {apiProtocols.map((protocol) => (
                        <SelectItem key={protocol} value={protocol}>
                          {endpointLabels[protocol]}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  自动依次尝试 Structured Outputs、JSON mode 和提示词 JSON；所有结果都在本地校验。
                </FieldDescription>
                {errors.apiMode && (
                  <FieldDescription role="alert">{errors.apiMode}</FieldDescription>
                )}
              </Field>
              {draft.apiMode === 'native' && (
                <Field data-invalid={!!errors.sdk}>
                  <FieldLabel htmlFor={`sdk-${draft.id}`}>Provider SDK</FieldLabel>
                  <SearchableSelect
                    id={`sdk-${draft.id}`}
                    value={draft.sdk}
                    aria-invalid={!!errors.sdk}
                    options={supportedSdks.map((sdk) => ({ value: sdk, label: sdk }))}
                    searchLabel="搜索官方 SDK"
                    searchPlaceholder="搜索 @ai-sdk 提供商…"
                    placeholder="选择官方 SDK"
                    emptyMessage="未找到匹配的 SDK。"
                    onValueChange={(sdk) => update('sdk', sdk)}
                  />
                  <FieldDescription>
                    选择官方 SDK 的原生端点；兼容服务统一使用 @ai-sdk/openai-compatible。
                  </FieldDescription>
                  {errors.sdk && <FieldDescription role="alert">{errors.sdk}</FieldDescription>}
                </Field>
              )}
              <Field>
                <FieldLabel htmlFor={`temperature-mode-${draft.id}`}>温度设置</FieldLabel>
                <Select
                  value={draft.temperature === null ? 'default' : 'custom'}
                  disabled={busy || saving || disabled || !selectedModel?.temperature}
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
              {draft.temperature !== null && selectedModel?.temperature && (
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
              <Field>
                <FieldLabel htmlFor={`timeout-${draft.id}`}>请求等待上限</FieldLabel>
                <Select
                  value={String(draft.requestTimeoutMs ?? 300000)}
                  disabled={busy || saving || disabled}
                  onValueChange={(v) => update('requestTimeoutMs', Number(v))}
                >
                  <SelectTrigger id={`timeout-${draft.id}`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {[
                        [0, '不限'],
                        [45000, '45 秒'],
                        [300000, '5 分钟'],
                        [900000, '15 分钟'],
                      ].map(([ms, label]) => (
                        <SelectItem key={ms} value={String(ms)}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  等待首个内容或后续内容的时间；持续返回内容时继续生成。
                </FieldDescription>
              </Field>
            </FieldGroup>
          </fieldset>
          {busy && (
            <div className="mt-3 flex flex-col gap-2" role="status">
              <span>{progress || '正在测试…'}</span>
            </div>
          )}

          {draft.capability && channelIsReady(value) && (
            <p className="mt-3 text-sm text-success">
              测试通过 · {draft.capability.protocols ? '完整协议' : '连接、JSON 校验与流式'} ·{' '}
              {formatDate(draft.capability.testedAt)}
              {' · 当前协议：'}
              {draft.capability.protocol && protocolLabels[draft.capability.protocol]}
            </p>
          )}
          {draft.capability?.ok && !channelIsReady(value) && (
            <p className="mt-3 text-sm text-muted-foreground">
              模型目录或渠道配置已变更，请重新测试渠道。
            </p>
          )}
          {draft.capability?.checks && (
            <div className="mt-3 flex flex-col gap-2" aria-label="协议测试结果">
              {apiProtocols.map((protocol) => {
                const check = draft.capability?.checks?.[protocol]
                if (!check) return null
                const labels = { passed: '通过', failed: '失败', untested: '未测试' }
                return (
                  <div key={protocol} className="text-sm">
                    <p>
                      {protocolLabels[protocol]} · 非流式：{labels[check.nonStreaming]} · 流式：
                      {labels[check.streaming]}
                      {check.outputMode && ` · 非流式 ${outputModeLabels[check.outputMode]}`}
                      {check.streamingOutputMode &&
                        ` · 流式 ${outputModeLabels[check.streamingOutputMode]}`}
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
          <Button type="submit" disabled={busy || saving || disabled || !catalog}>
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
              disabled={saving || disabled || !catalog}
              onClick={() => void test()}
            >
              <FlaskConical data-icon="inline-start" />
              测试渠道
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={busy || saving || disabled || !catalog}
            onClick={() => void test(true)}
          >
            完整协议测试
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={busy || saving || disabled || !catalog || !channelIsReady(value)}
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
