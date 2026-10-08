import { useId, useRef, useState } from 'react'
import { z } from 'zod'
import type { StoredMessage } from '@/lib/types'
import { editMessage } from '@/lib/db'
import { withArchiveOperation } from '@/lib/operations'
import { friendlyError } from '@/lib/provider'
import { ContentValidationError, narrativeSchema, forumSchema } from '@/lib/schemas'
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from './ui/dialog'
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs'
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from './ui/accordion'
import { Field, FieldGroup, FieldLabel, FieldSet, FieldLegend } from './ui/field'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from './ui/select'
import { Alert, AlertTitle, AlertDescription } from './ui/alert'
import { Button } from './ui/button'
import { FormField, ConfirmDialog, IconButton } from './shared'
import { LoaderCircle, Plus, Trash2 } from 'lucide-react'

const labels: Record<string, string> = {
  scene: '场景',
  effects: '剧情变化',
  speakerRef: '说话人引用',
  entityRefs: '人物引用',
  blocks: '正文',
  state: '状态',
  phone: '手机',
  diary: '日记',
  post: '帖子',
  answers: '回答',
  time: '时间',
  location: '地点',
  characters: '在场人物',
  quoteZh: '中文引语',
  quoteEn: '英文引语',
  source: '引语出处',
  kind: '段落类型',
  text: '内容',
  translation: '普通话翻译',
  innerVoice: '心声',
  desire: '欲望',
  wishes: '当前想做的事',
  spokenLine: '正文中的一句话',
  subtext: '潜台词',
  memos: '备忘录',
  recommendations: '今日推送',
  brand: '品牌',
  item: '名称',
  reaction: '感想',
  purchases: '购买记录',
  price: '价格',
  reason: '购买原因',
  conversations: '微信对话',
  contact: '联系人',
  messages: '对话消息',
  speaker: '说话的人',
  countdownDays: '距求婚的天数',
  explanation: '倒计时说明',
  title: '帖子标题',
  author: '作者',
  content: '帖子内容',
  tags: '标签',
  views: '浏览量',
  followers: '关注人数',
  likes: '赞同人数',
  replyTo: '回复对象',
}
const multiline = new Set([
  'text',
  'translation',
  'content',
  'innerVoice',
  'desire',
  'reason',
  'reaction',
  'quoteZh',
  'quoteEn',
  'explanation',
  'subtext',
  'spokenLine',
  'memos',
  'wishes',
])
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

function emptyValue(schema?: z.ZodType, name = ''): unknown {
  if (schema instanceof z.ZodNullable) return null
  if (schema instanceof z.ZodBoolean) return false
  if (name === 'id') return crypto.randomUUID()
  if (schema instanceof z.ZodObject)
    return Object.fromEntries(
      Object.entries(schema.shape).map(([key, child]) => [
        key,
        emptyValue(child as z.ZodType, key),
      ]),
    )
  if (schema instanceof z.ZodArray) return []
  if (schema instanceof z.ZodEnum) return schema.options[0]
  if (schema instanceof z.ZodNumber) return 0
  return ''
}

function PrimitiveField({
  name,
  label,
  value,
  schema,
  onChange,
}: {
  name: string
  label: string
  value: unknown
  schema?: z.ZodType
  onChange: (value: unknown) => void
}) {
  const id = useId()
  const numeric = schema instanceof z.ZodNumber || typeof value === 'number'
  const [longText] = useState(
    multiline.has(name) || (typeof value === 'string' && value.length > 80),
  )
  if (schema instanceof z.ZodBoolean)
    return (
      <Button type="button" variant="outline" onClick={() => onChange(!value)}>
        {label}：{value ? '是' : '否'}
      </Button>
    )
  if (schema instanceof z.ZodEnum)
    return (
      <Field>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Select value={typeof value === 'string' ? value : ''} onValueChange={onChange}>
          <SelectTrigger id={id} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {schema.options.map((option) => (
                <SelectItem key={option} value={String(option)}>
                  {option === 'narration' ? '叙述' : option === 'dialogue' ? '对白' : option}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
    )
  return (
    <FormField
      label={label}
      value={numeric ? Number(value ?? 0) : String(value ?? '')}
      type={numeric ? 'number' : 'text'}
      multiline={longText}
      className="max-h-64"
      onChange={(next) => onChange(numeric ? Number(next) : next)}
    />
  )
}

function ArrayFields({
  value,
  name,
  schema,
  onChange,
}: {
  value: unknown[]
  name: string
  schema?: z.ZodType
  onChange: (value: unknown) => void
}) {
  const [expanded, setExpanded] = useState(['0'])
  const elementSchema = schema instanceof z.ZodArray ? (schema.element as z.ZodType) : undefined
  const primitive =
    !(elementSchema instanceof z.ZodObject) && value.every((item) => !isObject(item))
  const title = labels[name] || '条目'
  const remove = (index: number) => {
    onChange(value.filter((_, i) => i !== index))
    setExpanded((previous) =>
      previous
        .filter((item) => Number(item) !== index)
        .map((item) => String(Number(item) > index ? Number(item) - 1 : Number(item))),
    )
  }
  return (
    <FieldGroup>
      {primitive ? (
        <div className="flex flex-col gap-4">
          {value.map((item, index) => (
            <div key={index} className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <PrimitiveField
                  name={name}
                  label={title + ' ' + (index + 1)}
                  value={item}
                  schema={elementSchema}
                  onChange={(next) =>
                    onChange(value.map((existing, i) => (i === index ? next : existing)))
                  }
                />
              </div>
              <IconButton
                type="button"
                label={`删除${title} ${index + 1}`}
                onClick={() => remove(index)}
              >
                <Trash2 />
              </IconButton>
            </div>
          ))}
        </div>
      ) : (
        <Accordion type="multiple" value={expanded} onValueChange={setExpanded}>
          {value.map((item, index) => {
            const title = isObject(item)
              ? item.author ||
                item.contact ||
                item.brand ||
                item.item ||
                (item.kind === 'dialogue' ? '对白' : item.kind === 'narration' ? '叙述' : '')
              : ''
            return (
              <AccordionItem key={index} value={String(index)}>
                <div className="flex items-center gap-2">
                  <AccordionTrigger className="min-w-0 flex-1">
                    <span className="min-w-0 truncate">
                      {index + 1}
                      {title ? ' · ' + String(title) : ''}
                    </span>
                  </AccordionTrigger>
                  <IconButton
                    type="button"
                    label={`删除${labels[name] || '条目'} ${index + 1}`}
                    onClick={() => remove(index)}
                  >
                    <Trash2 />
                  </IconButton>
                </div>
                <AccordionContent className="px-1 py-4">
                  <ValueFields
                    value={item}
                    schema={elementSchema}
                    onChange={(next) =>
                      onChange(value.map((existing, i) => (i === index ? next : existing)))
                    }
                  />
                </AccordionContent>
              </AccordionItem>
            )
          })}
        </Accordion>
      )}
      <Button
        type="button"
        variant="outline"
        className="w-fit"
        onClick={() => {
          onChange([...value, emptyValue(elementSchema)])
          setExpanded((previous) => [...previous, String(value.length)])
        }}
      >
        <Plus data-icon="inline-start" />
        添加{title}
      </Button>
    </FieldGroup>
  )
}

function ValueFields({
  value,
  name = '',
  schema,
  onChange,
}: {
  value: unknown
  name?: string
  schema?: z.ZodType
  onChange: (value: unknown) => void
}) {
  if (schema instanceof z.ZodNullable)
    return (
      <FieldGroup>
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            onChange(value === null ? emptyValue(schema.unwrap() as z.ZodType, name) : null)
          }
        >
          {value === null
            ? `${labels[name] || name}：未知，点击填写`
            : `${labels[name] || name}：改为未知`}
        </Button>
        {value !== null && (
          <ValueFields
            value={value}
            name={name}
            schema={schema.unwrap() as z.ZodType}
            onChange={onChange}
          />
        )}
      </FieldGroup>
    )
  if (Array.isArray(value) || schema instanceof z.ZodArray)
    return (
      <ArrayFields
        value={Array.isArray(value) ? value : []}
        name={name}
        schema={schema}
        onChange={onChange}
      />
    )
  if (isObject(value) || schema instanceof z.ZodObject) {
    const object = isObject(value) ? value : {}
    const fields = schema instanceof z.ZodObject ? { ...schema.shape, ...object } : object
    return (
      <FieldGroup>
        {Object.keys(fields)
          .filter((key) => key !== 'id')
          .map((key) => {
            const child = object[key]
            const childSchema =
              schema instanceof z.ZodObject ? (schema.shape[key] as z.ZodType) : undefined
            return (typeof child === 'object' && child !== null) ||
              childSchema instanceof z.ZodObject ||
              childSchema instanceof z.ZodArray ||
              childSchema instanceof z.ZodNullable ? (
              <FieldSet key={key}>
                <FieldLegend variant="label">{labels[key] || key}</FieldLegend>
                <ValueFields
                  value={child}
                  name={key}
                  schema={childSchema}
                  onChange={(next) => onChange({ ...object, [key]: next })}
                />
              </FieldSet>
            ) : (
              <PrimitiveField
                key={key}
                name={key}
                label={labels[key] || key}
                value={child}
                schema={childSchema}
                onChange={(next) => onChange({ ...object, [key]: next })}
              />
            )
          })}
      </FieldGroup>
    )
  }
  return (
    <PrimitiveField
      name={name}
      label={labels[name] || '内容'}
      value={value}
      schema={schema}
      onChange={onChange}
    />
  )
}

export function MessageEditor({
  message,
  disabled = false,
  onClose,
  onSaved,
}: {
  message: StoredMessage
  disabled?: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const original = message.reply
    ? JSON.stringify(message.reply.value, null, 2)
    : message.interaction
      ? JSON.stringify(message.interaction, null, 2)
      : message.effects
        ? JSON.stringify({ content: message.content, effects: message.effects }, null, 2)
        : typeof (message.rawContent || message.content) === 'string'
          ? message.rawContent || message.content
          : JSON.stringify(message.rawContent || message.content, null, 2)
  const [text, setText] = useState(original)
  const [tab, setTab] = useState(message.reply?.kind === 'forum' ? 'post' : 'blocks')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const errorRef = useRef<HTMLDivElement>(null)
  const schema = message.reply?.kind === 'forum' ? forumSchema : narrativeSchema
  const { guard, confirmation } = useUnsavedChanges(text !== original)
  let parsed: Record<string, unknown> | undefined
  if (message.reply) {
    try {
      const value: unknown = JSON.parse(text)
      if (isObject(value)) parsed = value
    } catch {
      /* Keep incomplete source editable. */
    }
  }
  const sections =
    message.reply?.kind === 'forum'
      ? [
          ['post', '帖子'],
          ['answers', '回答'],
        ]
      : [
          ['blocks', '正文'],
          ['scene', '场景'],
          ['state', '状态'],
          ['phone', '手机'],
          ['diary', '日记'],
          ['effects', '剧情变化'],
        ]
  const save = async () => {
    if (disabled || saving) return
    setSaving(true)
    setError('')
    try {
      await withArchiveOperation(message.archiveId, () => editMessage(message.id, text))
      onSaved()
      onClose()
    } catch (e) {
      if (e instanceof SyntaxError) {
        setTab('source')
        setError('原始内容不是有效的 JSON，请检查引号、逗号和括号后重新保存。')
      } else if (e instanceof ContentValidationError) {
        setError(
          e.issues
            .map((issue) =>
              issue.replace(
                /\b(?:scene|blocks|state|phone|diary|effects|post|answers)(?:\.[\w]+)*/g,
                (path) =>
                  path
                    .split('.')
                    .map((part) =>
                      /^\d+$/.test(part) ? String(Number(part) + 1) : labels[part] || part,
                    )
                    .join(' → '),
              ),
            )
            .join('；'),
        )
      } else setError(friendlyError(e))
      requestAnimationFrame(() => errorRef.current?.focus())
    } finally {
      setSaving(false)
    }
  }
  const change = (value: string) => {
    setText(value)
    setError('')
  }
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open && !saving) guard(onClose)
        }}
      >
        <DialogContent
          size="wide"
          className="editor-height overflow-hidden compact-height:gap-2"
          onEscapeKeyDown={(e) => saving && e.preventDefault()}
          onInteractOutside={(e) => saving && e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>编辑消息</DialogTitle>
            <DialogDescription>
              {message.reply
                ? '按分区修改回复，保存时会检查内容。相关摘要会在需要时重新整理。'
                : '修改后保留消息的时间和所属存档，相关摘要会在需要时重新整理。'}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <Alert
              ref={errorRef}
              tabIndex={-1}
              variant="destructive"
              className="max-h-40 shrink-0 overflow-y-auto"
            >
              <AlertTitle>修改尚未保存</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <form
            className="flex min-h-0 flex-1 flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              void save()
            }}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                (e.metaKey || e.ctrlKey) &&
                !e.nativeEvent.isComposing &&
                e.keyCode !== 229
              ) {
                e.preventDefault()
                void save()
              }
            }}
          >
            {message.reply ? (
              <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1">
                <TabsList className="w-full shrink-0 justify-start overflow-x-auto">
                  {sections.map(([key, title]) => (
                    <TabsTrigger key={key} value={key} className="flex-none sm:flex-1">
                      {title}
                    </TabsTrigger>
                  ))}
                  <TabsTrigger value="source" className="flex-none sm:flex-1">
                    原始内容
                  </TabsTrigger>
                </TabsList>
                {sections.map(([key]) => (
                  <TabsContent
                    key={key}
                    value={key}
                    className="min-h-0 overflow-y-auto overscroll-contain p-1"
                  >
                    {parsed ? (
                      <fieldset disabled={disabled || saving}>
                        <ValueFields
                          value={parsed[key]}
                          name={key}
                          schema={schema.shape[key as keyof typeof schema.shape]}
                          onChange={(value) =>
                            change(JSON.stringify({ ...parsed, [key]: value }, null, 2))
                          }
                        />
                      </fieldset>
                    ) : (
                      <Alert>
                        <AlertTitle>原始内容还不完整</AlertTitle>
                        <AlertDescription>请在「原始内容」中补全格式后继续编辑。</AlertDescription>
                      </Alert>
                    )}
                  </TabsContent>
                ))}
                <TabsContent value="source" className="min-h-0 overflow-y-auto p-1">
                  <FormField
                    label="原始 JSON 内容"
                    value={text}
                    onChange={change}
                    multiline
                    disabled={disabled || saving}
                    help="适合直接修改数据结构；保存时仍会检查所有字段。"
                    className="max-h-96 font-mono"
                  />
                </TabsContent>
              </Tabs>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto p-1">
                <FormField
                  label="消息内容"
                  value={text}
                  onChange={change}
                  multiline
                  disabled={disabled || saving}
                  autoFocus
                  className="max-h-96"
                />
              </div>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={disabled || saving}
                onClick={() => guard(onClose)}
              >
                取消
              </Button>
              <Button type="submit" disabled={disabled || saving}>
                {saving && <LoaderCircle data-icon="inline-start" className="animate-spin" />}
                保存修改
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        {...confirmation}
        title="放弃未保存的修改？"
        detail="消息修改还没有保存。可以取消返回编辑，或放弃修改后继续。"
        confirmLabel="放弃修改"
        destructive={false}
      />
    </>
  )
}
