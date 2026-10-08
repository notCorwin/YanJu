import { useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { archiveMessages, db } from '@/lib/db'
import type { Archive, TaskRun } from '@/lib/types'
import {
  applyTask,
  currentStory,
  executeAuxiliary,
  saveMediaDraft,
  storyMarkdown,
} from '@/lib/workflows'
import { taskDefinitions, type AuxiliaryKind, type TaskOutput } from '@/lib/tasks'
import { displayCountdown } from '@/lib/story'
import type { SourceRef } from '@/lib/domain-schema'
import { friendlyError } from '@/lib/provider'
import { requestTrack } from '@/lib/media'
import type { RequestKind } from '@/lib/schemas'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from './ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select'
import { Field, FieldGroup, FieldLabel, FieldDescription } from './ui/field'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'
import { Button } from './ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/card'
import { ArchiveBrowser } from './archive-browser'
import { Interactions } from './interactions'
import { TaskResult } from './task-results'
import { RequestHistory } from './request-history'
import { downloadText } from '@/lib/download'
import type { Notify } from './managers'
import { Square, Search, Download } from 'lucide-react'

const creations: AuxiliaryKind[] = [
  'persona',
  'archiveMetadata',
  'continuation',
  'rewrite',
  'consistency',
  'search',
  'chapters',
  'command',
]
const defaults: Partial<Record<AuxiliaryKind, string>> = {
  continuation: '给当前剧情提供3个不同的后续分支。',
  archiveMetadata: '根据有效剧情整理名称与简介。',
  consistency: '检查当前人设、时间、地点、知情范围和剧情一致性。',
  chapters: '按发生顺序整理当前有效剧情。',
  media: '推荐当前曲库中的配乐，并生成背景和语音描述。',
}
export function Studio({
  open,
  onClose,
  archive,
  disabled,
  onBusy,
  onSend,
  onSource,
  onCommand,
  notify,
  initialTab,
  initialContact,
  initialEntity,
}: {
  open: boolean
  onClose: () => void
  archive: Archive
  disabled: boolean
  onBusy: (busy: boolean) => void
  onSend: (text: string, kind: RequestKind) => void
  onSource: (source: SourceRef) => void
  onCommand: (value: TaskOutput<'command'>) => void
  notify: Notify
  initialTab?: string
  initialContact?: string
  initialEntity?: string
}) {
  const projection = useLiveQuery(() => db.storyStates.get(archive.id), [archive.id])
  const history = useLiveQuery(() => archiveMessages(archive.id), [archive.id]) ?? []
  const tasks =
    useLiveQuery(
      () => db.tasks.where('archiveId').equals(archive.id).reverse().sortBy('createdAt'),
      [archive.id],
    ) ?? []
  const settings = useLiveQuery(() => db.settings.get('app'))
  const story = currentStory(archive.id, projection)
  const [tab, setTab] = useState(initialTab ?? 'archives')
  const [kind, setKind] = useState<AuxiliaryKind>('continuation')
  const [text, setText] = useState('')
  const [targetId, setTargetId] = useState('')
  const [importText, setImportText] = useState('')
  const [search, setSearch] = useState('')
  const [running, setRunning] = useState(false)
  const [applying, setApplying] = useState(false)
  const sourceJump = useRef(false)
  const [shown, setShown] = useState(20)
  const [selectedTask, setSelectedTask] = useState('')
  const [localError, setLocalError] = useState('')
  const controller = useRef<AbortController | null>(null)
  const lock = useRef(false)
  const busy = disabled || running || applying
  const validNarratives = history.filter(
    (m) => m.reply?.kind === 'narrative' && m.status === 'complete' && !m.stale,
  )
  const currentTarget = validNarratives.find((m) => m.id === targetId) ?? validNarratives.at(-1)
  const sortedTasks = [...tasks].sort((a, b) => b.createdAt - a.createdAt)
  const featured = sortedTasks.find((t) => t.id === selectedTask)
  const count = displayCountdown(story)
  useEffect(() => {
    onBusy(running || applying)
  }, [running, applying, onBusy])
  useEffect(
    () => () => {
      controller.current?.abort()
      onBusy(false)
    },
    [onBusy],
  )
  const run = async (
    taskKind: AuxiliaryKind,
    input: string,
    target: string | null = null,
    showResult = true,
  ) => {
    if (busy || lock.current) return false
    lock.current = true
    setRunning(true)
    setLocalError('')
    controller.current = new AbortController()
    if (showResult) setTab('tasks')
    try {
      const task = await executeAuxiliary(archive.id, taskKind, input, target, {
        signal: controller.current.signal,
        onPartial: (task) => setSelectedTask(task.id),
      })
      setSelectedTask(task.id)
      if (showResult) setTab('tasks')
      if (task.status === 'complete') {
        if (taskKind === 'phoneReply' || taskKind === 'forumReply') notify('回复已追加并保存。')
        if (
          taskKind === 'media' &&
          settings?.autoMusic &&
          (task.output as TaskOutput<'media'>).trackId
        )
          requestTrack((task.output as TaskOutput<'media'>).trackId!, true)
      } else notify(task.error ?? '任务未完成，可重试。', true)
      return task.status === 'complete'
    } catch (error) {
      const detail = friendlyError(error)
      setLocalError(detail)
      notify(detail, true)
      return false
    } finally {
      lock.current = false
      setRunning(false)
      controller.current = null
    }
  }
  const apply = async (task: TaskRun, value?: unknown) => {
    if (lock.current) return
    lock.current = true
    setApplying(true)
    try {
      await applyTask(task.id, value)
      notify('结果已保存。')
    } catch (error) {
      notify(friendlyError(error), true)
    } finally {
      lock.current = false
      setApplying(false)
    }
  }
  const choose = async (task: TaskRun, action: string) => {
    if (lock.current) return
    lock.current = true
    setApplying(true)
    try {
      await applyTask(task.id)
      onSend(action, 'narrative')
    } catch (error) {
      notify(friendlyError(error), true)
    } finally {
      lock.current = false
      setApplying(false)
    }
  }
  const command = async (task: TaskRun, value: TaskOutput<'command'>) => {
    if (lock.current) return
    lock.current = true
    setApplying(true)
    try {
      await applyTask(task.id)
      if (value.action === 'search') {
        setSearch(value.query ?? '')
        setTab('archives')
        lock.current = false
        setApplying(false)
        void run('search', value.query!, null)
      } else onCommand(value)
    } catch (error) {
      notify(friendlyError(error), true)
    } finally {
      lock.current = false
      setApplying(false)
    }
  }
  const saveMedia = async (task: TaskRun, value: TaskOutput<'media'>) => {
    if (lock.current) return
    lock.current = true
    setApplying(true)
    try {
      await saveMediaDraft(task.id, value)
      notify('媒体描述已保存。')
    } catch (error) {
      notify(friendlyError(error), true)
    } finally {
      lock.current = false
      setApplying(false)
    }
  }
  const jumpToSource = (source: SourceRef) => {
    sourceJump.current = true
    onSource(source)
  }
  const result = (task: TaskRun) => (
    <TaskResult
      key={`${task.id}:${task.status}`}
      task={task}
      archive={archive}
      story={story}
      history={history}
      busy={busy}
      onApply={(t, v) => void apply(t, v)}
      onRetry={(t) =>
        void run(
          t.kind,
          t.input.text,
          t.input.targetId,
          !['phoneReply', 'forumReply'].includes(t.kind),
        )
      }
      onChoose={(t, action) => void choose(t, action)}
      onCommand={(t, v) => void command(t, v)}
      onSource={jumpToSource}
      onSaveMedia={(t, v) => void saveMedia(t, v)}
      onPlay={(id) => requestTrack(id, true)}
    />
  )
  const targetSelector = (
    <Field>
      <FieldLabel htmlFor="studio-target">目标叙事</FieldLabel>
      <Select value={currentTarget?.id ?? ''} onValueChange={setTargetId}>
        <SelectTrigger id="studio-target">
          <SelectValue placeholder="先生成一轮叙事" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {validNarratives.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.reply?.kind === 'narrative'
                  ? `${m.reply.value.scene.time} · ${m.reply.value.scene.location}`
                  : m.id}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  )
  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent
        className="w-full overflow-y-auto sm:max-w-(--reading-width)"
        onCloseAutoFocus={(event) => {
          if (sourceJump.current) {
            event.preventDefault()
            sourceJump.current = false
          }
        }}
      >
        <SheetHeader>
          <SheetTitle>剧情工作台</SheetTitle>
          <SheetDescription>
            {archive.name} · {story.clock.dateTime?.replace('T', ' ') ?? '剧情日期未知'} ·{' '}
            {count === null ? '求婚日期未设定' : `距求婚还有 ${count} 天`}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-8">
          {localError && (
            <p role="alert" className="text-sm text-destructive">
              {localError}
            </p>
          )}
          {running && (
            <div className="flex items-center justify-between gap-2" role="status">
              <p>正在生成，已收到的内容会保存到任务历史。</p>
              <Button variant="secondary" onClick={() => controller.current?.abort()}>
                <Square />
                停止任务
              </Button>
            </div>
          )}
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="grid h-auto w-full grid-cols-3 sm:grid-cols-6">
              {Object.entries({
                archives: '档案',
                interactions: '交互',
                creation: '创作',
                import: '资料',
                media: '媒体',
                tasks: '任务',
              }).map(([value, label]) => (
                <TabsTrigger key={value} value={value}>
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="archives" className="flex flex-col gap-5">
              <form
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault()
                  void run('search', search)
                }}
              >
                <Field>
                  <FieldLabel htmlFor="story-search">自然语言剧情搜索</FieldLabel>
                  <Input
                    id="story-search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="例如：查找宴雎在书房作出的承诺"
                  />
                </Field>
                <Button type="submit" variant="outline" disabled={busy || !search.trim()}>
                  <Search />
                  搜索剧情
                </Button>
              </form>
              <ArchiveBrowser story={story} onSource={jumpToSource} initialEntity={initialEntity} />
            </TabsContent>
            <TabsContent value="interactions">
              <Interactions
                key={initialContact ?? archive.id}
                story={story}
                busy={busy}
                onRun={(k, t, id) => run(k, t, id, false)}
                onSend={onSend}
                onSource={jumpToSource}
                initialContact={initialContact}
              />
              {featured &&
                ['phoneReply', 'forumReply'].includes(featured.kind) &&
                featured.status !== 'complete' && <div className="mt-4">{result(featured)}</div>}
            </TabsContent>
            <TabsContent value="creation" className="flex flex-col gap-4">
              <form
                className="flex flex-col gap-4"
                onSubmit={(e) => {
                  e.preventDefault()
                  void run(
                    kind,
                    text || defaults[kind] || '',
                    kind === 'rewrite' ? (currentTarget?.id ?? null) : null,
                  )
                }}
              >
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="studio-kind">创作与管理能力</FieldLabel>
                    <Select value={kind} onValueChange={(v) => setKind(v as AuxiliaryKind)}>
                      <SelectTrigger id="studio-kind">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {creations.map((k) => (
                            <SelectItem key={k} value={k}>
                              {taskDefinitions[k].label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  {kind === 'rewrite' && targetSelector}
                  <Field>
                    <FieldLabel htmlFor="studio-instruction">你的要求</FieldLabel>
                    <Textarea
                      id="studio-instruction"
                      rows={5}
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      placeholder={
                        kind === 'rewrite'
                          ? '例如：只改写第二段对白，让语气更克制；保留其他段落。也可指定手机、日记或状态模块。'
                          : (defaults[kind] ?? '写下要生成、查询或执行的内容')
                      }
                    />
                    <FieldDescription>
                      {kind === 'continuation'
                        ? '结果是尚未发生的建议，选择一个分支后才发送到剧情。'
                        : kind === 'command'
                          ? '支持搜索、模式切换、曲目选择、打开篇章、人物档案、手机和世界。'
                          : '生成后可预览结果，保存时会再次校验。'}
                    </FieldDescription>
                  </Field>
                </FieldGroup>
                <Button
                  type="submit"
                  disabled={
                    busy ||
                    (!text.trim() && !defaults[kind]) ||
                    (kind === 'rewrite' && !currentTarget)
                  }
                >
                  生成{taskDefinitions[kind].label}
                </Button>
              </form>
              <Card size="sm">
                <CardHeader>
                  <CardTitle>开场生成</CardTitle>
                  <CardDescription>
                    按当前人设和你的要求生成完整叙事开场，保存到当前篇章。
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      onSend(
                        `请生成完整开场。${text || '结合当前人设，选择合适的相遇场景。'}`,
                        'narrative',
                      )
                    }
                  >
                    生成开场
                  </Button>
                </CardContent>
              </Card>
              <Button
                variant="outline"
                onClick={() =>
                  downloadText(
                    `${archive.name}.md`,
                    storyMarkdown(archive, history),
                    'text/markdown',
                  )
                }
              >
                <Download />
                导出剧情 Markdown
              </Button>
            </TabsContent>
            <TabsContent value="import" className="flex flex-col gap-4">
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="material-file">导入资料文件</FieldLabel>
                  <Input
                    id="material-file"
                    type="file"
                    accept=".txt,.md,.json,text/plain,application/json"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (!file) return
                      void file
                        .arrayBuffer()
                        .then((buffer) => {
                          const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
                          if (file.name.toLowerCase().endsWith('.json')) {
                            const parsed = JSON.parse(content) as Record<string, unknown>
                            if (
                              'version' in parsed &&
                              ('archives' in parsed || 'messages' in parsed)
                            )
                              throw new Error(
                                '这里仅接收角色或世界资料；应用存档请使用存档管理，新版只支持 v3。',
                              )
                          }
                          setImportText(content)
                        })
                        .catch((error) => notify(friendlyError(error), true))
                    }}
                  />
                  <FieldDescription>
                    支持 UTF-8 文本、Markdown、角色与世界资料 JSON。
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="material-text">粘贴文本或资料 JSON</FieldLabel>
                  <Textarea
                    id="material-text"
                    rows={10}
                    value={importText}
                    onChange={(e) => setImportText(e.target.value)}
                  />
                </Field>
              </FieldGroup>
              <Button
                disabled={busy || !importText.trim()}
                onClick={() => void run('contentImport', importText)}
              >
                提取资料并预览
              </Button>
            </TabsContent>
            <TabsContent value="media" className="flex flex-col gap-4">
              {targetSelector}
              <Field orientation="horizontal">
                <Input
                  id="auto-music"
                  type="checkbox"
                  className="size-4"
                  checked={settings?.autoMusic ?? false}
                  onChange={(e) => void db.settings.update('app', { autoMusic: e.target.checked })}
                />
                <FieldLabel htmlFor="auto-music">媒体结果生成后自动播放推荐配乐</FieldLabel>
              </Field>
              <p className="text-sm text-muted-foreground">
                默认显示推荐，点击后播放。背景与语音描述可编辑保存并导出。
              </p>
              <Button
                disabled={busy || !currentTarget}
                onClick={() => void run('media', defaults.media!, currentTarget?.id ?? null)}
              >
                生成媒体描述与配乐建议
              </Button>
              {sortedTasks.find((t) => t.kind === 'media' && t.status === 'complete') &&
                result(sortedTasks.find((t) => t.kind === 'media' && t.status === 'complete')!)}
            </TabsContent>
            <TabsContent value="tasks" className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">
                {sortedTasks.length} 项任务 · 部分内容只用于预览与恢复，完整结果通过校验后才能应用。
              </p>
              <RequestHistory archiveId={archive.id} />
              {featured && result(featured)}
              {sortedTasks
                .filter((t) => t.id !== featured?.id)
                .slice(0, shown)
                .map(result)}
              {!sortedTasks.length && (
                <p className="text-muted-foreground">这里会保留生成结果、草稿和失败恢复记录。</p>
              )}
              {sortedTasks.length > shown + (featured ? 1 : 0) && (
                <Button variant="outline" onClick={() => setShown((v) => v + 20)}>
                  展开更早的任务
                </Button>
              )}
            </TabsContent>
          </Tabs>
        </div>
      </SheetContent>
    </Sheet>
  )
}
