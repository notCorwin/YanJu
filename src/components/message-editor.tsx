import { useEffect, useId, useRef, useState } from 'react'
import { z } from 'zod'
import { editMessage } from '@/lib/db'
import { withArchiveOperation } from '@/lib/operations'
import { forumSchema, narrativeSchema } from '@/lib/schemas'
import { friendlyError } from '@/lib/provider'
import type { StoredMessage } from '@/lib/types'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion'
import { Field, FieldLabel, FieldGroup, FieldSet, FieldLegend } from './ui/field'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select'
import { Button } from './ui/button'
import { IconButton } from './shared'
import { Plus, Trash2, LoaderCircle } from 'lucide-react'

const labels: Record<string, string> = {
  scene: '场景',
  effects: '剧情变化',
  speakerRef: '说话人引用',
  entityRefs: '人物引用',
  blocks: '正文与对白',
  state: '状态',
  phone: '手机',
  diary: '日记',
  time: '时间',
  location: '地点',
  characters: '在场人物',
  quoteZh: '中文引语',
  quoteEn: '英文引语',
  source: '出处',
  kind: '类型',
  text: '内容',
  translation: '普通话翻译',
  innerVoice: '心声',
  desire: '欲望',
  wishes: '愿望',
  spokenLine: '正文中的一句话',
  subtext: '内心含义',
  memos: '备忘录',
  recommendations: '品牌推送',
  brand: '品牌',
  item: '物品',
  reaction: '反应',
  purchases: '购买记录',
  price: '价格',
  reason: '原因',
  conversations: '聊天',
  contact: '联系人',
  messages: '消息',
  speaker: '说话人',
  countdownDays: '距求婚天数',
  explanation: '解释',
  post: '帖子',
  answers: '回答',
  id: '编号',
  title: '标题',
  author: '作者',
  content: '正文',
  tags: '标签',
  views: '浏览数',
  followers: '关注数',
  likes: '赞同数',
  replyTo: '回复对象',
}
const label = (path: string[]) =>
  path
    .map((part) => labels[part] ?? (/^\d+$/.test(part) ? `第 ${Number(part) + 1} 条` : part))
    .join(' · ')
function empty(schema: z.ZodType): unknown {
  if (schema instanceof z.ZodNullable) return null
  if (schema instanceof z.ZodBoolean) return false
  if (schema instanceof z.ZodObject)
    return Object.fromEntries(
      Object.entries(schema.shape).map(([key, child]) => [key, empty(child as z.ZodType)]),
    )
  if (schema instanceof z.ZodArray) return []
  if (schema instanceof z.ZodEnum) return schema.options[0]
  if (schema instanceof z.ZodNumber) return 0
  return ''
}
function SchemaField({
  schema,
  value,
  path,
  onChange,
  error,
}: {
  schema: z.ZodType
  value: unknown
  path: string[]
  onChange: (value: unknown) => void
  error: string
}) {
  const id = useId()
  const title = label(path)
  const invalid =
    !!error &&
    (error.includes(path.join('.')) || error.includes(labels[path.at(-1)!] ?? path.at(-1)!))
  if (schema instanceof z.ZodNullable)
    return (
      <FieldGroup>
        <Button
          variant="outline"
          onClick={() => onChange(value === null ? empty(schema.unwrap() as z.ZodType) : null)}
        >
          {value === null ? `${title}：未知，点击填写` : `${title}：改为未知`}
        </Button>
        {value !== null && (
          <SchemaField
            schema={schema.unwrap() as z.ZodType}
            value={value}
            path={path}
            onChange={onChange}
            error={error}
          />
        )}
      </FieldGroup>
    )
  if (schema instanceof z.ZodObject) {
    const object = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
    return (
      <FieldGroup>
        {Object.entries(schema.shape).map(([key, child]) => (
          <SchemaField
            key={key}
            schema={child as z.ZodType}
            value={object[key]}
            path={[...path, key]}
            error={error}
            onChange={(next) => onChange({ ...object, [key]: next })}
          />
        ))}
      </FieldGroup>
    )
  }
  if (schema instanceof z.ZodArray) {
    const values: unknown[] = Array.isArray(value) ? value : []
    return (
      <FieldSet>
        <FieldLegend>
          {title}（{values.length} 条）
        </FieldLegend>
        <Accordion type="multiple">
          {values.map((item, index) => (
            <AccordionItem key={index} value={String(index)}>
              <div className="flex items-center gap-2">
                <AccordionTrigger className="min-w-0 flex-1">
                  {title} · 第 {index + 1} 条
                </AccordionTrigger>
                <IconButton
                  label={`删除 ${title} 第 ${index + 1} 条`}
                  onClick={() => onChange(values.filter((_, i) => i !== index))}
                >
                  <Trash2 />
                </IconButton>
              </div>
              <AccordionContent>
                <SchemaField
                  schema={schema.element as z.ZodType}
                  value={item}
                  path={[...path, String(index)]}
                  error={error}
                  onChange={(next) =>
                    onChange(values.map((original, i) => (i === index ? next : original)))
                  }
                />
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
        <Button
          variant="outline"
          className="w-fit"
          onClick={() => onChange([...values, empty(schema.element as z.ZodType)])}
        >
          <Plus data-icon="inline-start" />
          添加{labels[path.at(-1)!] ?? '一条'}
        </Button>
      </FieldSet>
    )
  }
  return (
    <Field data-invalid={invalid || undefined}>
      <FieldLabel htmlFor={id}>{title}</FieldLabel>
      {schema instanceof z.ZodEnum ? (
        <Select value={typeof value === 'string' ? value : ''} onValueChange={onChange}>
          <SelectTrigger id={id} aria-invalid={invalid || undefined}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {schema.options.map((option) => (
                <SelectItem key={String(option)} value={String(option)}>
                  {option === 'narration'
                    ? '叙述'
                    : option === 'dialogue'
                      ? '对白'
                      : String(option)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      ) : schema instanceof z.ZodNumber ? (
        <Input
          id={id}
          type="number"
          value={typeof value === 'number' ? value : 0}
          aria-invalid={invalid || undefined}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      ) : (
        <Textarea
          id={id}
          rows={3}
          value={typeof value === 'string' ? value : ''}
          aria-invalid={invalid || undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  )
}

export function MessageEditor({
  message,
  onClose,
  onSaved,
  disabled = false,
}: {
  message: StoredMessage
  disabled?: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const [text, setText] = useState(() =>
    message.reply
      ? JSON.stringify(message.reply.value, null, 2)
      : message.interaction
        ? JSON.stringify(message.interaction, null, 2)
        : message.effects
          ? JSON.stringify({ content: message.content, effects: message.effects }, null, 2)
          : typeof (message.rawContent || message.content) === 'string'
            ? message.rawContent || message.content
            : JSON.stringify(message.rawContent || message.content, null, 2),
  )
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const errorRef = useRef<HTMLParagraphElement>(null)
  const schema = message.reply?.kind === 'forum' ? forumSchema : narrativeSchema
  let object: Record<string, unknown> | undefined
  try {
    object = z.record(z.string(), z.unknown()).parse(JSON.parse(text))
  } catch {
    /* JSON editing remains available. */
  }
  useEffect(() => {
    if (error)
      (
        root.current?.querySelector<HTMLElement>('[aria-invalid="true"]') ?? errorRef.current
      )?.focus()
  }, [error])
  const save = async () => {
    if (disabled || busy) return
    setBusy(true)
    setError('')
    try {
      await withArchiveOperation(message.archiveId, () => editMessage(message.id, text))
      onSaved()
      onClose()
    } catch (error) {
      setError(friendlyError(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent ref={root} className="max-h-[90dvh] overflow-y-auto sm:page-width">
        <DialogHeader>
          <DialogTitle>编辑消息</DialogTitle>
          <DialogDescription>
            按内容分区编辑，或使用完整 JSON。保存时检查完整协议；相关摘要会自动失效。
          </DialogDescription>
        </DialogHeader>
        {message.reply ? (
          <Tabs defaultValue={object ? 'structured' : 'json'}>
            <TabsList className="group-data-horizontal/tabs:h-auto">
              <TabsTrigger className="min-h-11" value="structured" disabled={!object}>
                内容编辑
              </TabsTrigger>
              <TabsTrigger className="min-h-11" value="json">
                JSON 编辑
              </TabsTrigger>
            </TabsList>
            <TabsContent value="structured">
              {object && (
                <Tabs defaultValue={message.reply.kind === 'narrative' ? 'blocks' : 'post'}>
                  <TabsList className="flex flex-wrap gap-1 group-data-horizontal/tabs:h-auto">
                    {Object.keys(schema.shape).map((key) => (
                      <TabsTrigger className="h-auto min-h-11 flex-none px-3" key={key} value={key}>
                        {labels[key]}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                  {Object.entries(schema.shape).map(([key, child]) => (
                    <TabsContent key={key} value={key}>
                      <SchemaField
                        schema={child}
                        value={object[key]}
                        path={[key]}
                        error={error}
                        onChange={(next) => {
                          setText(JSON.stringify({ ...object, [key]: next }, null, 2))
                          setError('')
                        }}
                      />
                    </TabsContent>
                  ))}
                </Tabs>
              )}
            </TabsContent>
            <TabsContent value="json">
              <Field>
                <FieldLabel htmlFor="edit-message">完整 JSON 内容</FieldLabel>
                <Textarea
                  id="edit-message"
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value)
                    setError('')
                  }}
                  rows={12}
                />
              </Field>
            </TabsContent>
          </Tabs>
        ) : (
          <Field>
            <FieldLabel htmlFor="edit-message">消息内容</FieldLabel>
            <Textarea
              id="edit-message"
              value={text}
              onChange={(e) => {
                setText(e.target.value)
                setError('')
              }}
              rows={12}
            />
          </Field>
        )}
        {error && (
          <p
            ref={errorRef}
            role="alert"
            tabIndex={-1}
            className="wrap-break-word text-sm text-destructive"
          >
            {error}
          </p>
        )}
        <DialogFooter>
          <Button disabled={disabled || busy || !text.trim()} onClick={() => void save()}>
            {busy && <LoaderCircle data-icon="inline-start" className="animate-spin" />}保存修改
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
