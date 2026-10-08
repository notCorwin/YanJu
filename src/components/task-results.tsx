import { downloadText } from '@/lib/download'
import { useState } from 'react'
import type { TaskRun, Archive, StoredMessage } from '@/lib/types'
import { taskDefinitions, validateTask, type TaskOutput } from '@/lib/tasks'
import type { StoryState } from '@/lib/story'
import { entityName } from '@/lib/story'
import type { SourceRef } from '@/lib/domain-schema'
import { searchStory, storyMarkdown } from '@/lib/workflows'
import { tracks } from '@/lib/media'
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from './ui/card'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { FieldGroup } from './ui/field'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select'
import { FormField, Prose } from './shared'
import { SourceButton } from './archive-browser'
import { NarrativeView } from './replies'

export function TaskResult({
  task,
  archive,
  story,
  history,
  busy,
  onApply,
  onRetry,
  onChoose,
  onCommand,
  onSource,
  onSaveMedia,
  onPlay,
}: {
  task: TaskRun
  archive: Archive
  story: StoryState
  history: StoredMessage[]
  busy: boolean
  onApply: (task: TaskRun, value?: unknown) => void
  onRetry: (task: TaskRun) => void
  onChoose: (task: TaskRun, action: string) => void
  onCommand: (task: TaskRun, value: TaskOutput<'command'>) => void
  onSource: (source: SourceRef) => void
  onSaveMedia: (task: TaskRun, value: TaskOutput<'media'>) => void
  onPlay: (id: string) => void
}) {
  const [edited, setEdited] = useState(task.output)
  const [shown, setShown] = useState(20)
  const value = edited ?? task.output
  const apply = () => onApply(task, value)
  const canApply = !busy && !task.applied
  let result: React.ReactNode = null
  if (task.status !== 'complete') {
    const partial =
      task.partial && typeof task.partial === 'object'
        ? (task.partial as Record<string, unknown>)
        : {}
    const text = ['title', 'name', 'summary', 'text', 'content', 'background', 'reason']
      .map((key) => (typeof partial[key] === 'string' ? partial[key] : ''))
      .filter(Boolean)
      .join('\n\n')
    result = (
      <>
        <Prose text={text} />
        <p
          role={task.error ? 'alert' : 'status'}
          className={task.error ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}
        >
          {task.error ?? (task.correction ? '正在纠正结果…' : '正在生成结果…')}
        </p>
        {task.status !== 'partial' && (
          <Button variant="outline" disabled={busy} onClick={() => onRetry(task)}>
            重试任务
          </Button>
        )}
      </>
    )
  } else if (task.kind === 'persona') {
    const v = value as TaskOutput<'persona'>
    result = (
      <>
        <FieldGroup>
          {(['name', 'gender', 'identity', 'prefer', 'force'] as const).map((key) => (
            <FormField
              key={key}
              label={
                {
                  name: '草稿姓名',
                  gender: '草稿性别',
                  identity: '草稿身份',
                  prefer: '草稿偏好',
                  force: '草稿规则',
                }[key]
              }
              value={v[key]}
              multiline={['prefer', 'force'].includes(key)}
              onChange={(text) => setEdited({ ...v, [key]: text })}
            />
          ))}
        </FieldGroup>
        <Button disabled={!canApply} onClick={apply}>
          保存人设草稿
        </Button>
      </>
    )
  } else if (task.kind === 'archiveMetadata') {
    const v = value as TaskOutput<'archiveMetadata'>
    result = (
      <>
        <FieldGroup>
          <FormField
            label="篇章名称"
            value={v.name}
            onChange={(name) => setEdited({ ...v, name })}
          />
          <FormField
            label="篇章简介"
            multiline
            value={v.summary}
            onChange={(summary) => setEdited({ ...v, summary })}
          />
          <FormField
            label="关键词"
            value={v.keywords.join('、')}
            onChange={(text) =>
              setEdited({
                ...v,
                keywords: text
                  .split(/[,，、]/)
                  .map((x) => x.trim())
                  .filter(Boolean),
              })
            }
          />
        </FieldGroup>
        <Button disabled={!canApply} onClick={apply}>
          保存篇章简介
        </Button>
      </>
    )
  } else if (task.kind === 'continuation') {
    result = (value as TaskOutput<'continuation'>).options.map((option) => (
      <Card key={option.id} size="sm">
        <CardHeader>
          <CardTitle>{option.title}</CardTitle>
          <CardDescription>{option.scene}</CardDescription>
        </CardHeader>
        <CardContent>
          <Prose text={option.action} />
        </CardContent>
        <CardFooter>
          <Button disabled={!canApply} onClick={() => onChoose(task, option.action)}>
            选择这个分支
          </Button>
        </CardFooter>
      </Card>
    ))
  } else if (task.kind === 'rewrite') {
    const v = value as TaskOutput<'rewrite'>
    result = (
      <>
        <p className="text-sm text-muted-foreground">
          修改 {v.changedBlockIds.length}{' '}
          个段落及必要的关联字段。应用后，目标之后的记录保留展示并标记失效，剧情状态从有效记录重建。
        </p>
        <NarrativeView reply={v.replacement} />
        <Button disabled={!canApply} onClick={apply}>
          应用改写
        </Button>
      </>
    )
  } else if (task.kind === 'consistency') {
    const v = value as TaskOutput<'consistency'>
    result = (
      <>
        <Prose text={v.summary} />
        {v.issues.map((issue, i) => (
          <Card key={i} size="sm">
            <CardHeader>
              <CardTitle>
                {{ info: '提示', warning: '需留意', error: '需修正' }[issue.severity]} ·{' '}
                {
                  {
                    character: '人设',
                    time: '时间',
                    location: '地点',
                    knowledge: '知情范围',
                    reference: '引用',
                    other: '剧情',
                  }[issue.type]
                }
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <blockquote className="border-l-(length:--border-width) pl-3">
                <Prose text={issue.evidence} />
              </blockquote>
              <Prose text={issue.suggestion} />
            </CardContent>
            <CardFooter>
              <SourceButton source={issue.source} onSource={onSource} />
            </CardFooter>
          </Card>
        ))}
      </>
    )
  } else if (task.kind === 'search') {
    const hits = searchStory(story, history, value as TaskOutput<'search'>)
    result = (
      <>
        <p role="status">找到 {hits.length} 条结果</p>
        {hits.slice(0, shown).map((hit) => (
          <Card size="sm" key={`${hit.category}:${hit.id}`}>
            <CardHeader>
              <CardTitle>{hit.title}</CardTitle>
              <CardDescription>{hit.date ?? '日期未知'}</CardDescription>
            </CardHeader>
            <CardContent>
              <Prose text={hit.text.slice(0, 600)} />
            </CardContent>
            <CardFooter>
              <SourceButton source={hit.source} onSource={onSource} />
            </CardFooter>
          </Card>
        ))}
        {hits.length > shown && (
          <Button variant="outline" onClick={() => setShown((s) => s + 20)}>
            展开更多搜索结果
          </Button>
        )}
      </>
    )
  } else if (task.kind === 'contentImport') {
    const v = value as TaskOutput<'contentImport'>
    const name = (ref: string) =>
      v.effects.entities.find((e) => e.ref === ref)?.name ?? entityName(story, ref)
    result = (
      <>
        <h4 className="text-lg">{v.title}</h4>
        <Prose text={v.summary} />
        {v.effects.entities.map((e) => (
          <Card size="sm" key={e.ref}>
            <CardHeader>
              <CardTitle>{e.name}</CardTitle>
              <CardDescription>
                {{ character: '人物', location: '地点', organization: '组织' }[e.kind]}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Prose text={e.description} />
            </CardContent>
          </Card>
        ))}
        {v.effects.relationships.map((r) => (
          <p key={r.ref}>
            {name(r.from)} → {name(r.to)}：{r.type} · {r.description}
          </p>
        ))}
        {v.effects.memories.map((m) => (
          <p key={m.ref}>
            {m.kind === 'preference' ? '偏好' : '事实'}：{m.content}
          </p>
        ))}
        {v.effects.states.map((s) => (
          <p key={`${s.entityRef}:${s.key}`}>
            {name(s.entityRef)} · {s.key}：{s.value}
          </p>
        ))}
        {v.effects.knowledge.map((k) => (
          <p key={k.ref}>
            {name(k.entityRef)} 知道：{k.fact}
          </p>
        ))}
        {v.effects.events.map((e) => (
          <p key={e.ref}>
            {e.time ?? '日期未知'} · {e.title}：{e.description}
          </p>
        ))}
        {v.effects.goals.map((g) => (
          <p key={g.ref}>
            {name(g.ownerRef)}的目标：{g.description} · {g.dueDate ?? '期限未知'}
          </p>
        ))}
        {v.unrecognized.length > 0 && (
          <>
            <h4 className="font-medium">未识别内容</h4>
            <ul className="list-disc pl-5">
              {v.unrecognized.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </>
        )}
        <Button disabled={!canApply} onClick={apply}>
          保存提取资料
        </Button>
      </>
    )
  } else if (task.kind === 'chapters') {
    const v = value as TaskOutput<'chapters'>
    let markdown: string | undefined
    try {
      markdown = storyMarkdown(archive, history, v)
    } catch {
      /* An older chapter result must not omit or export changed story records. */
    }
    result = (
      <>
        <h4 className="text-lg">{v.title}</h4>
        {v.chapters.map((chapter, i) => (
          <Card size="sm" key={i}>
            <CardHeader>
              <CardTitle>{chapter.title}</CardTitle>
              <CardDescription>{chapter.messageIds.length} 条原文</CardDescription>
            </CardHeader>
            <CardContent>
              <Prose text={chapter.summary} />
            </CardContent>
            <CardFooter className="flex flex-wrap gap-2">
              {chapter.messageIds.slice(0, 10).map((id, j) => (
                <Button
                  key={id}
                  size="sm"
                  variant="ghost"
                  onClick={() => onSource({ messageId: id, blockId: null })}
                >
                  原文 {j + 1}
                </Button>
              ))}
            </CardFooter>
          </Card>
        ))}
        <Button
          variant="outline"
          disabled={busy || markdown === undefined}
          onClick={() => downloadText(`${archive.name}.md`, markdown!, 'text/markdown')}
        >
          导出整理后的剧情 Markdown
        </Button>
        {markdown === undefined && (
          <p role="alert" className="text-sm text-destructive">
            有效剧情已变化，请重新整理章节后导出全部原文。
          </p>
        )}
      </>
    )
  } else if (task.kind === 'media') {
    const v = value as TaskOutput<'media'>
    let validated: TaskOutput<'media'> | undefined
    let mediaError = ''
    try {
      validated = validateTask('media', v)
    } catch {
      mediaError = '请补全背景和语音描述后保存或导出。'
    }
    result = (
      <>
        <p className="text-sm text-muted-foreground">{v.reason}</p>
        <Select
          value={v.trackId ?? 'none'}
          onValueChange={(id) => setEdited({ ...v, trackId: id === 'none' ? null : id })}
        >
          <SelectTrigger aria-label="推荐曲目">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="none">不配乐</SelectItem>
              {tracks.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <FieldGroup>
          <FormField
            label="背景描述"
            value={v.background}
            multiline
            onChange={(background) => setEdited({ ...v, background })}
          />
          {v.voice.map((item, i) => (
            <FormField
              key={item.blockId}
              label={`${item.speaker} · 语音描述 ${i + 1}`}
              value={item.direction}
              multiline
              onChange={(direction) =>
                setEdited({
                  ...v,
                  voice: v.voice.map((entry, index) =>
                    index === i ? { ...entry, direction } : entry,
                  ),
                })
              }
            />
          ))}
        </FieldGroup>
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy || !validated} onClick={() => onSaveMedia(task, v)}>
            保存媒体描述
          </Button>
          {v.trackId && (
            <Button variant="outline" onClick={() => onPlay(v.trackId!)}>
              播放推荐配乐
            </Button>
          )}
          <Button
            variant="outline"
            disabled={busy || !validated}
            onClick={() =>
              downloadText(
                `${archive.name}-media.json`,
                JSON.stringify(validated, null, 2),
                'application/json',
              )
            }
          >
            导出媒体描述 JSON
          </Button>
        </div>
        {mediaError && (
          <p role="alert" className="text-sm text-destructive">
            {mediaError}
          </p>
        )}
      </>
    )
  } else if (task.kind === 'command') {
    const v = value as TaskOutput<'command'>
    result = (
      <>
        <Prose text={v.explanation} />
        <Button disabled={!canApply} onClick={() => onCommand(task, v)}>
          执行操作
        </Button>
      </>
    )
  } else if (task.kind === 'phoneReply') {
    result = <Prose text={(value as TaskOutput<'phoneReply'>).text} />
  } else if (task.kind === 'forumReply') {
    result = <Prose text={(value as TaskOutput<'forumReply'>).content} />
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2">
          {taskDefinitions[task.kind].label}
          <Badge variant="outline">
            {task.applied
              ? '已应用'
              : { complete: '已完成', partial: '生成中', failed: '待恢复', cancelled: '已停止' }[
                  task.status
                ]}
          </Badge>
        </CardTitle>
        <CardDescription>{new Date(task.createdAt).toLocaleString('zh-CN')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {['phoneReply', 'forumReply'].includes(task.kind) && (
          <blockquote className="border-l-(length:--border-width) pl-3">
            <p className="text-xs text-muted-foreground">你的消息</p>
            <Prose text={task.input.text} />
          </blockquote>
        )}
        {result}
      </CardContent>
    </Card>
  )
}
