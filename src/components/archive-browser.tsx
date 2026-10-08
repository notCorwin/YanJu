import { useState } from 'react'
import type { StoryState } from '@/lib/story'
import { entityName } from '@/lib/story'
import type { SourceRef } from '@/lib/domain-schema'
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from './ui/card'
import { Button } from './ui/button'
import { Input } from './ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select'
import { Field, FieldGroup, FieldLabel } from './ui/field'
import { Prose } from './shared'

export function SourceButton({
  source,
  onSource,
}: {
  source: SourceRef
  onSource: (source: SourceRef) => void
}) {
  return (
    <Button size="sm" variant="ghost" onClick={() => onSource(source)}>
      {source.messageId === 'setting' ? '固定设定' : '查看来源'}
    </Button>
  )
}
export function ArchiveBrowser({
  story,
  onSource,
  initialEntity,
}: {
  story: StoryState
  onSource: (source: SourceRef) => void
  initialEntity?: string
}) {
  const [category, setCategory] = useState('entities')
  const [query, setQuery] = useState('')
  const [entity, setEntity] = useState(initialEntity || 'all')
  const [shown, setShown] = useState(20)
  const names = (ids: string[]) => ids.map((id) => entityName(story, id)).join('、')
  const rows = {
    entities: story.entities.map((e) => ({
      ...e,
      title: e.name,
      text: e.description,
      info: { character: '人物', location: '地点', organization: '组织' }[e.kind],
      entities: [e.id],
    })),
    states: story.states.map((e) => ({
      ...e,
      title: `${entityName(story, e.entityRef)} · ${e.key}`,
      text: e.value,
      info: '当前状态',
      entities: [e.entityRef],
    })),
    relationships: story.relationships.map((e) => ({
      ...e,
      title: `${entityName(story, e.from)} → ${entityName(story, e.to)}`,
      text: e.description,
      info: e.type,
      entities: [e.from, e.to],
    })),
    knowledge: story.knowledge.map((e) => ({
      ...e,
      title: `${entityName(story, e.entityRef)} 知道`,
      text: e.fact,
      info: '知情范围',
      entities: [e.entityRef],
    })),
    events: [...story.events]
      .reverse()
      .map((e) => ({
        ...e,
        title: e.title,
        text: e.description,
        info: `${e.time ?? '日期未知'} · ${names(e.participants)}${e.locationRef ? ` · ${entityName(story, e.locationRef)}` : ''}`,
        entities: [...e.participants, ...(e.locationRef ? [e.locationRef] : [])],
      })),
    memories: story.memories.map((e) => ({
      ...e,
      title: e.kind === 'preference' ? '偏好' : '长期事实',
      text: e.content,
      info: `${names(e.entityRefs)}${e.status === 'retracted' ? ' · 已撤回' : ''}`,
      entities: e.entityRefs,
    })),
    goals: story.goals.map((e) => ({
      ...e,
      title: e.description,
      text: `${entityName(story, e.ownerRef)} · ${e.dueDate ?? '期限未知'}`,
      info: { open: '进行中', done: '已完成', cancelled: '已取消' }[e.status],
      entities: [e.ownerRef],
    })),
  }
  const filtered = rows[category as keyof typeof rows].filter(
    (e) =>
      (entity === 'all' || e.entities.includes(entity)) &&
      `${e.title} ${e.text} ${e.info}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  )
  const relations = story.relationships.filter(
    (r) => entity === 'all' || r.from === entity || r.to === entity,
  )
  const nodes = story.entities
    .filter((e) => relations.some((r) => r.from === e.id || r.to === e.id))
    .slice(0, 16)
  const positions = new Map(
    nodes.map((e, i) => [
      e.id,
      {
        x: 210 + 145 * Math.cos((i * Math.PI * 2) / nodes.length),
        y: 165 + 110 * Math.sin((i * Math.PI * 2) / nodes.length),
      },
    ]),
  )
  return (
    <div className="flex flex-col gap-4">
      <FieldGroup className="grid gap-3 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="archive-category">档案分类</FieldLabel>
          <Select
            value={category}
            onValueChange={(v) => {
              setCategory(v)
              setShown(20)
            }}
          >
            <SelectTrigger id="archive-category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {Object.entries({
                  entities: '人物与世界',
                  states: '角色状态',
                  relationships: '关系图',
                  knowledge: '知情范围',
                  events: '时间线',
                  memories: '长期记忆',
                  goals: '目标与承诺',
                }).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="archive-entity">筛选实体</FieldLabel>
          <Select
            value={entity}
            onValueChange={(v) => {
              setEntity(v)
              setShown(20)
            }}
          >
            <SelectTrigger id="archive-entity">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">全部实体</SelectItem>
                {story.entities.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field className="sm:col-span-2">
          <FieldLabel htmlFor="archive-filter">检索档案</FieldLabel>
          <Input
            id="archive-filter"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setShown(20)
            }}
            placeholder="输入姓名、地点、事件或关键词"
          />
        </Field>
      </FieldGroup>
      {category === 'relationships' && nodes.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>人物关系图</CardTitle>
            <CardDescription>选择人物可筛选其关系；下方记录包含关系依据。</CardDescription>
          </CardHeader>
          <CardContent>
            <svg
              viewBox="0 0 420 330"
              role="img"
              aria-label="人物关系图"
              className="w-full text-primary"
            >
              <title>人物关系与联系</title>
              {relations.map((r) => {
                const a = positions.get(r.from),
                  b = positions.get(r.to)
                return a && b ? (
                  <line key={r.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="currentColor">
                    <title>
                      {r.type}：{r.description}
                    </title>
                  </line>
                ) : null
              })}
              {nodes.map((n) => {
                const p = positions.get(n.id)!
                return (
                  <g key={n.id}>
                    <circle cx={p.x} cy={p.y} r={22} className="fill-card stroke-primary" />
                    <text
                      x={p.x}
                      y={p.y + 5}
                      textAnchor="middle"
                      className="fill-foreground text-xs"
                    >
                      {n.name}
                    </text>
                  </g>
                )
              })}
            </svg>
            <div className="flex flex-wrap gap-2">
              {nodes.map((n) => (
                <Button
                  key={n.id}
                  size="sm"
                  variant={entity === n.id ? 'secondary' : 'outline'}
                  onClick={() => setEntity(n.id)}
                >
                  {n.name}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
      <p className="text-sm text-muted-foreground" role="status">
        {filtered.length} 条记录
      </p>
      {!filtered.length && (
        <p className="text-muted-foreground">
          尚无匹配记录。继续剧情或导入资料后，这里会显示可追踪的档案。
        </p>
      )}
      {filtered.slice(0, shown).map((e) => (
        <Card key={e.id} size="sm">
          <CardHeader>
            <CardTitle>{e.title}</CardTitle>
            <CardDescription>{e.info}</CardDescription>
          </CardHeader>
          <CardContent>
            <Prose text={e.text} />
          </CardContent>
          <CardFooter>
            <SourceButton source={e.source} onSource={onSource} />
          </CardFooter>
        </Card>
      ))}
      {filtered.length > shown && (
        <Button variant="outline" onClick={() => setShown((s) => s + 20)}>
          展开更多档案（还有 {filtered.length - shown} 条）
        </Button>
      )}
    </div>
  )
}
