import { ConfirmDialog, FormField, IconButton } from '@/components/shared'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
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
  currentModelCatalog,
  findCatalogModel,
  fuzzyCatalogModel,
  modelParameters,
  modelCatalogProviderId,
  selectCatalogModel,
  subscribeModelCatalog,
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
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

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
    Omit<Channel, 'temperature' | 'contextWindow' | 'maxOutputTokens'> & {
      temperature: number | string | null
      contextWindow: number | string
      maxOutputTokens: number | string
    }
  >(channel)
  const catalog = useSyncExternalStore(subscribeModelCatalog, currentModelCatalog)
  useEffect(() => {
    if (!catalog) return
    setDraft((previous) => {
      const source = catalog[modelCatalogProviderId(previous)]
      const model =
        source?.models[previous.model] ??
        (previous.manualModelId ? fuzzyCatalogModel(source, previous.model) : undefined)
      if (!model) return previous
      return {
        ...previous,
        ...modelParameters(model),
        ...(previous.contextWindowOverride ? { contextWindow: previous.contextWindow } : {}),
        ...(previous.maxOutputTokensOverride ? { maxOutputTokens: previous.maxOutputTokens } : {}),
        temperature: previous.temperatureOverride
          ? previous.temperature
          : model.temperature === true
            ? previous.temperature
            : null,
      }
    })
  }, [catalog])
  const custom = draft.connectionMode === 'custom'
  const provider =
    catalog?.[draft.connectionMode === 'custom' ? (draft.modelProviderId ?? '') : draft.providerId]
  const selectedModel =
    provider?.models[draft.model] ??
    (draft.manualModelId ? fuzzyCatalogModel(provider, draft.model) : undefined)
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
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  const value: Channel = {
    ...draft,
    temperature: draft.temperature === null ? null : Number(draft.temperature),
    contextWindow: Number(draft.contextWindow),
    maxOutputTokens: Number(draft.maxOutputTokens),
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
      ...(key === 'temperature' ? { temperatureOverride: value !== null } : {}),
      ...(key === 'contextWindow' ? { contextWindowOverride: true } : {}),
      ...(key === 'maxOutputTokens' ? { maxOutputTokensOverride: true } : {}),
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
    const resolved = {
      ...next,
      baseUrl: next.connectionMode === 'custom' ? next.baseUrl : '',
    }
    if (provider && selectedModel && !next.manualModelId) {
      Object.assign(resolved, {
        ...selectCatalogModel(resolved, provider, selectedModel),
        apiMode: next.apiMode,
        sdk: next.sdk,
        baseUrl: next.connectionMode === 'custom' ? next.baseUrl : '',
        name: next.name,
        contextWindow: next.contextWindow,
        contextWindowOverride: next.contextWindowOverride,
        inputLimit: next.inputLimit,
        maxOutputTokens: next.maxOutputTokens,
        maxOutputTokensOverride: next.maxOutputTokensOverride,
        temperature: next.temperature,
        temperatureSupported: next.temperatureSupported,
      })
    }
    if (channelFingerprint(resolved) === channelFingerprint(next)) {
      resolved.capability = next.capability
      resolved.calibration = next.calibration
    }
    const issues = channelValidationErrors(resolved)
    if (!custom && !provider) issues.providerId = '请选择 Models.dev 中的 Provider。'
    if (!selectedModel && !next.manualModelId)
      issues.model = '请选择 Models.dev 中的文本模型，或输入自定义模型 ID。'
    setErrors(issues)
    if (Object.keys(issues).length) {
      if (
        Object.keys(issues).some((key) =>
          [
            'model',
            'apiMode',
            'sdk',
            'baseUrl',
            'temperature',
            'maxOutputTokens',
            'contextWindow',
          ].includes(key),
        )
      )
        setAdvancedOpen(true)
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
                        apiMode: 'auto',
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
                    : '从 Models.dev 选择服务商，自动使用其预置地址、SDK 和认证方式。'}
                </FieldDescription>
                {(errors.providerId || errors.connectionMode) && (
                  <FieldDescription role="alert">
                    {errors.providerId || errors.connectionMode}
                  </FieldDescription>
                )}
              </Field>
              <Field data-invalid={!!errors.model}>
                <FieldLabel htmlFor={`model-${draft.id}`}>模型</FieldLabel>
                {!draft.manualModelId && (
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
                )}
                <FieldDescription>
                  {custom
                    ? '列表中的服务商名称仅标明模型资料来源。请求发送至自定义 Base URL，调用方式由 API 端点决定。'
                    : '所有支持文本输入与输出的模型均可选择。'}
                  {selectedModel &&
                    `上下文 ${selectedModel.limit.context.toLocaleString()} tokens · ${selectedModel.structured_output ? '支持 Structured Outputs' : '自动选择 JSON 输出模式'}`}
                </FieldDescription>
                {errors.model && <FieldDescription role="alert">{errors.model}</FieldDescription>}
              </Field>
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
              {custom && (
                <FormField
                  label="Base URL"
                  name="baseUrl"
                  error={errors.baseUrl}
                  value={draft.baseUrl}
                  placeholder="https://example.com/v1"
                  help="填写此服务的地址、API 前缀或完整端点。"
                  onChange={(v) => update('baseUrl', v)}
                  autoComplete="off"
                />
              )}
              <Accordion
                type="single"
                collapsible
                value={advancedOpen ? 'advanced' : ''}
                onValueChange={(value) => setAdvancedOpen(value === 'advanced')}
              >
                <AccordionItem value="advanced">
                  <AccordionTrigger>高级设置</AccordionTrigger>
                  <AccordionContent>
                    <FieldGroup>
                      {draft.manualModelId ? (
                        <>
                          <FormField
                            label="自定义 Model ID"
                            name="model"
                            error={errors.model}
                            value={draft.model}
                            onChange={(model) => {
                              const found =
                                custom && catalog
                                  ? findCatalogModel(catalog, model, draft.modelProviderId)
                                  : undefined
                              const match = found?.model ?? fuzzyCatalogModel(provider, model)
                              setDraft((previous) => ({
                                ...previous,
                                model,
                                manualModelId: true,
                                ...(found ? { modelProviderId: found.provider.id } : {}),
                                ...(match
                                  ? {
                                      ...modelParameters(match),
                                      ...(previous.contextWindowOverride
                                        ? { contextWindow: previous.contextWindow }
                                        : {}),
                                      ...(previous.maxOutputTokensOverride
                                        ? { maxOutputTokens: previous.maxOutputTokens }
                                        : {}),
                                      temperature: previous.temperatureOverride
                                        ? previous.temperature
                                        : match.temperature === true
                                          ? (previous.temperature ?? 0.9)
                                          : null,
                                    }
                                  : {}),
                                capability: undefined,
                                calibration: undefined,
                              }))
                              setErrors((previous) => ({ ...previous, model: undefined }))
                            }}
                            help={
                              selectedModel
                                ? `Models.dev 的相近匹配：${selectedModel.id}；容量可在下方覆盖。`
                                : '未找到相近模型时，请在下方手动填写 Context Window 与 max_tokens。'
                            }
                            autoComplete="off"
                          />
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() =>
                              setDraft((previous) => ({ ...previous, manualModelId: false }))
                            }
                          >
                            从 Models.dev 选择
                          </Button>
                        </>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          disabled={!catalog || (!custom && !provider)}
                          onClick={() => {
                            setDraft((previous) => ({
                              ...previous,
                              manualModelId: true,
                              modelProviderId: custom
                                ? previous.modelProviderId || providers[0]?.id || ''
                                : previous.providerId,
                              capability: undefined,
                              calibration: undefined,
                            }))
                          }}
                        >
                          输入目录外的 Model ID
                        </Button>
                      )}
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
                              <SelectItem value="auto">自动探测所有支持的端点</SelectItem>
                              {apiProtocols.map((protocol) => (
                                <SelectItem key={protocol} value={protocol}>
                                  {endpointLabels[protocol]}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                        <FieldDescription>
                          优先探测模型资料对应的端点，再检查其他候选端点。所有端点均验证非流式和流式
                          JSON，通过后自动选定；也可手动指定端点。
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
                            兼容服务统一使用 @ai-sdk/openai-compatible。
                          </FieldDescription>
                          {errors.sdk && (
                            <FieldDescription role="alert">{errors.sdk}</FieldDescription>
                          )}
                        </Field>
                      )}
                      <FormField
                        label="Context Window"
                        name="contextWindow"
                        error={errors.contextWindow}
                        type="number"
                        min={1024}
                        step={1}
                        value={draft.contextWindow}
                        onChange={(v) => update('contextWindow', v)}
                        help="已按 Models.dev 模型资料填充；仅影响本地上下文预算。"
                      />
                      <FormField
                        label="max_tokens"
                        name="maxOutputTokens"
                        error={errors.maxOutputTokens}
                        type="number"
                        min={1}
                        step={1}
                        value={draft.maxOutputTokens}
                        onChange={(v) => update('maxOutputTokens', v)}
                        help="已按 Models.dev 输出上限填充，并作为每次生成的输出上限。"
                      />
                      <Field>
                        <FieldLabel htmlFor={`temperature-mode-${draft.id}`}>
                          Temperature
                        </FieldLabel>
                        <Select
                          value={draft.temperature === null ? 'default' : 'custom'}
                          disabled={busy || saving || disabled}
                          onValueChange={(mode) =>
                            update('temperature', mode === 'default' ? null : 0.9)
                          }
                        >
                          <SelectTrigger id={`temperature-mode-${draft.id}`} className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectItem value="default">系统默认</SelectItem>
                              <SelectItem value="custom">自定义</SelectItem>
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                        <FieldDescription>
                          系统依据模型资料设置默认值，也可手动覆盖。不支持温度参数的端点可能拒绝自定义值。
                        </FieldDescription>
                      </Field>
                      {draft.temperature !== null && (
                        <FormField
                          label="Temperature"
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
                    </FieldGroup>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
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
