import { useState } from 'react'
import type { StoryState } from '@/lib/story'
import { formatMinor, type SourceRef } from '@/lib/domain-schema'
import type { AuxiliaryKind } from '@/lib/tasks'
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from './ui/card'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { Input } from './ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select'
import { Field, FieldLabel, FieldGroup } from './ui/field'
import { Message, MessageContent, MessageHeader } from './ui/message'
import { Bubble, BubbleContent } from './ui/bubble'
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
} from './ui/message-scroller'
import { SourceButton } from './archive-browser'
import { Prose } from './shared'

export function Interactions({
  story,
  busy,
  onRun,
  onSend,
  onSource,
  initialContact,
}: {
  story: StoryState
  busy: boolean
  onRun: (kind: AuxiliaryKind, text: string, targetId: string | null) => Promise<boolean>
  onSend: (text: string, kind: 'narrative' | 'forum') => void
  onSource: (source: SourceRef) => void
  initialContact?: string
}) {
  const [section, setSection] = useState('phone')
  const [contactId, setContactId] = useState(initialContact ?? '')
  const [postId, setPostId] = useState('')
  const [target, setTarget] = useState('')
  const [text, setText] = useState('')
  const [title, setTitle] = useState('')
  const [shown, setShown] = useState(20)
  const [date, setDate] = useState('')
  const contact = story.phones.find((p) => p.id === contactId) ?? story.phones[0]
  const post = story.forums.find((p) => p.id === postId) ?? story.forums.at(-1)
  const records =
    section === 'memos'
      ? [...story.memos].reverse().map((m) => ({ ...m, title: '备忘录' }))
      : section === 'purchases'
        ? [...story.purchases].reverse().map((p) => ({
            ...p,
            title: p.item,
            text: `${p.price} · ${p.reason}${p.amountMinor !== null ? `（${formatMinor(p.amountMinor, p.currency!)}）` : '（金额未知）'}`,
          }))
        : [...story.diaries].reverse().map((d) => ({ ...d, title: '宴雎的日记' }))
  const filtered = records.filter((r) => !date || r.date === date)
  return (
    <div className="flex flex-col gap-4">
      <Field>
        <FieldLabel htmlFor="interaction-section">独立交互</FieldLabel>
        <Select
          value={section}
          onValueChange={(v) => {
            setSection(v)
            setShown(20)
            setText('')
            setTarget('')
          }}
        >
          <SelectTrigger id="interaction-section">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {Object.entries({
                phone: '手机会话',
                forum: '论坛历史',
                newPost: '发布新帖',
                memos: '备忘录',
                purchases: '购买记录',
                diaries: '日记日历',
              }).map(([v, label]) => (
                <SelectItem key={v} value={v}>
                  {label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      {section === 'phone' && (
        <>
          <Field>
            <FieldLabel htmlFor="phone-contact">联系人</FieldLabel>
            <Select
              value={contact?.id ?? ''}
              onValueChange={(v) => {
                setContactId(v)
                setShown(20)
              }}
            >
              <SelectTrigger id="phone-contact">
                <SelectValue placeholder="继续叙事后出现联系人" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {story.phones.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.contact}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          {contact ? (
            <>
              {contact.messages.length > shown && (
                <Button variant="outline" onClick={() => setShown((s) => s + 20)}>
                  读取更早的消息
                </Button>
              )}
              <div className="flex h-80 min-h-0 flex-col rounded-lg border-(length:--border-width)">
                <MessageScrollerProvider defaultScrollPosition="end">
                  <MessageScroller>
                    <MessageScrollerViewport>
                      <MessageScrollerContent className="p-3">
                        {contact.messages.slice(-shown).map((m) => (
                          <MessageScrollerItem key={m.id}>
                            <Message align={m.id.endsWith(':user') ? 'end' : 'start'}>
                              <MessageContent>
                                <MessageHeader>
                                  {m.speaker} · {m.time}
                                </MessageHeader>
                                <Bubble variant={m.id.endsWith(':user') ? 'secondary' : 'muted'}>
                                  <BubbleContent>
                                    <Prose text={m.text} />
                                  </BubbleContent>
                                </Bubble>
                              </MessageContent>
                            </Message>
                          </MessageScrollerItem>
                        ))}
                      </MessageScrollerContent>
                    </MessageScrollerViewport>
                  </MessageScroller>
                </MessageScrollerProvider>
              </div>
              <form
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (text.trim() && !busy) {
                    const original = text
                    void onRun('phoneReply', original, contact.id).then((success) => { if (success) setText((current) => current === original ? '' : current) })
                  }
                }}
              >
                <Field>
                  <FieldLabel htmlFor="phone-input">手机消息</FieldLabel>
                  <Textarea
                    id="phone-input"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder={`给${contact.contact}发消息`}
                    rows={3}
                  />
                </Field>
                <Button type="submit" disabled={busy || !text.trim()}>
                  发送手机消息
                </Button>
              </form>
            </>
          ) : (
            <p className="text-muted-foreground">叙事中的手机对话会在这里成为可独立打开的会话。</p>
          )}
        </>
      )}
      {section === 'forum' && (
        <>
          <Field>
            <FieldLabel htmlFor="forum-history">帖子</FieldLabel>
            <Select
              value={post?.id ?? ''}
              onValueChange={(v) => {
                setPostId(v)
                setShown(20)
                setTarget('')
              }}
            >
              <SelectTrigger id="forum-history">
                <SelectValue placeholder="尚无帖子" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {story.forums.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.post.title}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          {post ? (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>{post.post.title}</CardTitle>
                  <CardDescription>
                    {post.post.author} · {post.post.time} · {post.answers.length} 条回答
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Prose text={post.post.content} />
                </CardContent>
                <CardFooter>
                  <SourceButton source={post.source} onSource={onSource} />
                  <Button variant="outline" onClick={() => setTarget(post.id)}>
                    回复帖子
                  </Button>
                </CardFooter>
              </Card>
              {post.answers.slice(0, shown).map((a) => (
                <Card size="sm" key={a.id}>
                  <CardHeader>
                    <CardTitle>{a.author}</CardTitle>
                    <CardDescription>
                      {a.time}
                      {a.replyTo
                        ? ` · 回复 ${post.answers.find((item) => item.id === a.replyTo)?.author ?? '帖子'}`
                        : ''}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Prose text={a.content} />
                  </CardContent>
                  <CardFooter>
                    <Button
                      size="sm"
                      variant={target === a.id ? 'secondary' : 'ghost'}
                      onClick={() => setTarget(a.id)}
                    >
                      回复这条回答
                    </Button>
                    <SourceButton source={a.source} onSource={onSource} />
                  </CardFooter>
                </Card>
              ))}
              {post.answers.length > shown && (
                <Button variant="outline" onClick={() => setShown((s) => s + 20)}>
                  展开更多回答（还有 {post.answers.length - shown} 条）
                </Button>
              )}
              {target && (
                <form
                  className="flex flex-col gap-3"
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (text.trim() && !busy) {
                      const original = text
                      void onRun('forumReply', original, target).then((success) => { if (success) setText((current) => current === original ? '' : current) })
                    }
                  }}
                >
                  <Field>
                    <FieldLabel htmlFor="forum-append">
                      回复 {post.answers.find((a) => a.id === target)?.author ?? '帖子'}
                    </FieldLabel>
                    <Textarea
                      id="forum-append"
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      rows={3}
                    />
                  </Field>
                  <Button type="submit" disabled={busy || !text.trim()}>
                    发送论坛回复
                  </Button>
                </form>
              )}
            </>
          ) : (
            <p className="text-muted-foreground">
              选择「发布新帖」建立帖子，首次生成完整50条回答。
            </p>
          )}
        </>
      )}
      {section === 'newPost' && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            onSend(`$发送帖子\n标题：${title}\n${text}`, 'forum')
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="post-title">新帖标题</FieldLabel>
              <Input id="post-title" value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="post-body">新帖内容</FieldLabel>
              <Textarea
                id="post-body"
                rows={5}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </Field>
          </FieldGroup>
          <p className="text-sm text-muted-foreground">
            首次生成50条回答；后续回复按用户原文与一条 NPC 回复追加。
          </p>
          <Button type="submit" disabled={busy || !title.trim() || !text.trim()}>
            发布新帖
          </Button>
        </form>
      )}
      {['memos', 'purchases', 'diaries'].includes(section) && (
        <>
          <Field>
            <FieldLabel htmlFor="diary-date">剧情日期</FieldLabel>
            <Input
              id="diary-date"
              type="date"
              value={date}
              onChange={(e) => {
                setDate(e.target.value)
                setShown(20)
              }}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setDate('')}>
              全部日期与未知日期
            </Button>
            {[...new Set(records.map((r) => r.date).filter((d): d is string => d !== null))]
              .sort()
              .slice(-14)
              .map((day) => (
                <Button
                  size="sm"
                  variant={date === day ? 'secondary' : 'ghost'}
                  key={day}
                  onClick={() => {
                    setDate(day)
                    setShown(20)
                  }}
                >
                  {day}（{records.filter((r) => r.date === day).length}）
                </Button>
              ))}
          </div>
          <p className="text-sm text-muted-foreground">{filtered.length} 条记录</p>
          {filtered.slice(0, shown).map((r) => (
            <Card size="sm" key={r.id}>
              <CardHeader>
                <CardTitle>{r.title}</CardTitle>
                <CardDescription>{r.date ?? '日期未知'}</CardDescription>
              </CardHeader>
              <CardContent>
                <Prose text={r.text} />
              </CardContent>
              <CardFooter>
                <SourceButton source={r.source} onSource={onSource} />
              </CardFooter>
            </Card>
          ))}
          {!filtered.length && <p className="text-muted-foreground">当前日期没有记录。</p>}
          {filtered.length > shown && (
            <Button variant="outline" onClick={() => setShown((s) => s + 20)}>
              展开更多记录
            </Button>
          )}
        </>
      )}
    </div>
  )
}
