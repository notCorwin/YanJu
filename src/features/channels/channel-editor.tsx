import { ConfirmDialog, FormField, IconButton } from '@/components/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { protocolLabels } from '@/lib/channels'
import { channelIsReady } from '@/lib/provider'
import { type ApiMode, type ApiProtocol, type Channel, type Notify } from '@/lib/types'
import { Check, FlaskConical, LoaderCircle, Trash2 } from 'lucide-react'
import { useChannelEditor } from './use-channel-editor'

const formatDate = (value: number) => new Date(value).toLocaleString('zh-CN', { hour12: false })

export function ChannelEditor({
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
  const { draft, busy, progress, remove, setRemove, update, save, test, cancel, removeChannel } =
    useChannelEditor(channel, notify)
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
              help="填写 API 根地址（通常以 /v1 结尾），不含 /responses 或 /chat/completions。"
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
            <Field>
              <FieldLabel htmlFor={`api-mode-${draft.id}`}>API 协议</FieldLabel>
              <Select
                value={draft.apiMode}
                disabled={busy || disabled}
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
                disabled={busy || disabled}
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
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={draft.temperature}
                  onChange={(v) => update('temperature', Number(v))}
                />
              )}
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
              {busy ? (
                <LoaderCircle data-icon="inline-start" className="animate-spin" />
              ) : (
                <FlaskConical data-icon="inline-start" />
              )}
              测试渠道
            </Button>
            <Button variant="secondary" disabled={!channelIsReady(draft)} onClick={onUse}>
              <Check data-icon="inline-start" />
              使用此渠道
            </Button>
            <IconButton label="删除渠道" variant="destructive" onClick={() => setRemove(true)}>
              <Trash2 data-icon="inline-start" />
            </IconButton>
          </div>
        </fieldset>
        {busy && (
          <div className="mt-3 flex items-center gap-2" role="status">
            <LoaderCircle className="animate-spin" />
            {progress || '正在测试…'}
            <Button variant="ghost" onClick={cancel}>
              取消测试
            </Button>
          </div>
        )}
        {draft.capability?.ok && (
          <p className="mt-3 text-sm text-success">
            测试通过 · {formatDate(draft.capability.testedAt)}
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
          onConfirm={removeChannel}
        />
      </CardContent>
    </Card>
  )
}
