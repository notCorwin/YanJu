import { useState } from 'react'
import type { DeepPartial } from 'ai'
import type { ForumReply, NarrativeReply } from '@/lib/schemas'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion'
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from './ui/card'
import { Bubble, BubbleContent } from './ui/bubble'
import { Message, MessageContent, MessageHeader } from './ui/message'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from './ui/dialog'
import { Textarea } from './ui/textarea'
import { Field, FieldLabel } from './ui/field'
import { Eyebrow, Prose } from './shared'
import { MessageSquare, PenLine } from 'lucide-react'

type Scene = DeepPartial<NarrativeReply['scene']>
function SceneCard({ scene }: { scene: Scene }) {
  return (
    <Card size="sm">
      <CardHeader>
        <Eyebrow>SCENE / 场景</Eyebrow>
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            ['时间', scene.time],
            ['地点', scene.location],
            ['在场', scene.characters?.filter(Boolean).join('、')],
          ].map(([name, value]) => (
            <div key={name}>
              <p className="text-xs text-muted-foreground">{name}</p>
              <p className="text-ui">{value || '…'}</p>
            </div>
          ))}
        </div>
      </CardHeader>
      {scene.quoteZh && (
        <CardContent className="flex flex-col gap-2">
          <p className="text-chat leading-prose">{scene.quoteZh}</p>
          <p className="font-serif italic text-sm text-muted-foreground">{scene.quoteEn}</p>
          {scene.source && <p className="text-xs text-primary">— {scene.source}</p>}
        </CardContent>
      )}
    </Card>
  )
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h4 className="text-ui font-medium text-primary">{title}</h4>
      {children}
    </section>
  )
}
export function NarrativeView({
  reply,
  messageId,
}: {
  reply: DeepPartial<NarrativeReply>
  messageId?: string
}) {
  return (
    <div className="flex flex-col gap-6">
      {reply.scene && <SceneCard scene={reply.scene} />}
      <div className="flex flex-col gap-5">
        {reply.blocks?.map(
          (block, i) =>
            block && (
              <div
                key={block.id ?? i}
                id={messageId && block.id ? `source-block-${messageId}-${block.id}` : undefined}
                tabIndex={-1}
                className={
                  block.kind === 'dialogue'
                    ? 'border-l-(length:--border-width) border-primary pl-4'
                    : ''
                }
              >
                <Prose text={block.text} />
                {block.kind === 'dialogue' && block.translation && (
                  <p className="mt-2 text-ui text-muted-foreground">「{block.translation}」</p>
                )}
              </div>
            ),
        )}
      </div>
      <Accordion type="multiple">
        {reply.state && (
          <AccordionItem value="state">
            <AccordionTrigger>
              <span className="flex flex-col gap-1">
                <Eyebrow>STATE / INTERNAL</Eyebrow>
                <span>宴雎 · 此刻</span>
              </span>
            </AccordionTrigger>
            <AccordionContent>
              <div className="flex flex-col gap-6 py-3">
                <Section title="心声">
                  <Prose text={reply.state.innerVoice} />
                </Section>
                <Section title="欲望">
                  <Prose text={reply.state.desire} />
                </Section>
                <Section title="当前最想做的是">
                  <ol className="flex list-decimal flex-col gap-3 pl-5">
                    {reply.state.wishes?.map((text, i) => (
                      <li key={i}>
                        <Prose text={text} />
                      </li>
                    ))}
                  </ol>
                </Section>
                <Section title="正文中的一句话">
                  <Prose text={reply.state.spokenLine} />
                  <p className="text-ui text-muted-foreground">→ {reply.state.subtext}</p>
                </Section>
              </div>
            </AccordionContent>
          </AccordionItem>
        )}
        {reply.phone && (
          <AccordionItem value="phone">
            <AccordionTrigger>
              <span className="flex flex-col gap-1">
                <Eyebrow>DEVICE / INTERFACE</Eyebrow>
                <span>宴雎 · 手机</span>
              </span>
            </AccordionTrigger>
            <AccordionContent>
              <div className="flex flex-col gap-6 py-3">
                <Section title="备忘录">
                  <ul className="flex list-disc flex-col gap-3 pl-5">
                    {reply.phone.memos?.map((memo, i) => (
                      <li key={i}>
                        <Prose text={memo} />
                      </li>
                    ))}
                  </ul>
                </Section>
                <Section title="今日推送">
                  <div className="grid gap-3 sm:grid-cols-2">
                    {reply.phone.recommendations?.map(
                      (r, i) =>
                        r && (
                          <Card size="sm" key={i}>
                            <CardHeader>
                              <CardTitle>{r.brand}</CardTitle>
                              <CardDescription>{r.item}</CardDescription>
                            </CardHeader>
                            <CardContent>
                              <Prose text={r.reaction} />
                            </CardContent>
                          </Card>
                        ),
                    )}
                  </div>
                </Section>
                <Section title="购买记录">
                  <div className="flex flex-col gap-3">
                    {reply.phone.purchases?.map(
                      (p, i) =>
                        p && (
                          <Card size="sm" key={i}>
                            <CardHeader>
                              <CardTitle>{p.item}</CardTitle>
                              <CardDescription>{p.price}</CardDescription>
                            </CardHeader>
                            <CardContent>
                              <Prose text={p.reason} />
                            </CardContent>
                          </Card>
                        ),
                    )}
                  </div>
                </Section>
                <Section title="微信对话">
                  {reply.phone.conversations?.map(
                    (c, i) =>
                      c && (
                        <Card size="sm" key={i}>
                          <CardHeader>
                            <CardTitle>{c.contact}</CardTitle>
                          </CardHeader>
                          <CardContent className="flex flex-col gap-4">
                            {c.messages?.map(
                              (m, j) =>
                                m && (
                                  <Message key={j} align={m.speaker === '宴雎' ? 'end' : 'start'}>
                                    <MessageContent>
                                      <MessageHeader>
                                        {m.speaker} · {m.time}
                                      </MessageHeader>
                                      <Bubble
                                        variant={m.speaker === '宴雎' ? 'secondary' : 'muted'}
                                        align={m.speaker === '宴雎' ? 'end' : 'start'}
                                      >
                                        <BubbleContent>
                                          <Prose text={m.text} />
                                        </BubbleContent>
                                      </Bubble>
                                    </MessageContent>
                                  </Message>
                                ),
                            )}
                          </CardContent>
                        </Card>
                      ),
                  )}
                </Section>
              </div>
            </AccordionContent>
          </AccordionItem>
        )}
        {reply.diary && (
          <AccordionItem value="diary">
            <AccordionTrigger>
              <span className="flex flex-col gap-1">
                <Eyebrow>DIARY / COUNTDOWN</Eyebrow>
                <span>宴雎 · 日记</span>
              </span>
            </AccordionTrigger>
            <AccordionContent>
              <div className="flex flex-col gap-4 py-3">
                <Prose text={reply.diary.text} />
                <p className="text-ui text-primary">
                  {reply.diary.countdownDays == null
                    ? '求婚日期未设定'
                    : `距求婚还有 ${reply.diary.countdownDays} 天`}
                </p>
                <p className="text-ui text-muted-foreground">{reply.diary.explanation}</p>
              </div>
            </AccordionContent>
          </AccordionItem>
        )}
      </Accordion>
    </div>
  )
}
export function ForumView({
  reply,
  onSend,
  onReply,
  disabled,
}: {
  reply: DeepPartial<ForumReply>
  onReply?: (id: string, text: string) => void
  onSend: (text: string) => void
  disabled?: boolean
}) {
  const [target, setTarget] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [title, setTitle] = useState('')
  const [shown, setShown] = useState(10)
  const answers = reply.answers?.filter(Boolean) ?? []
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <Eyebrow>FORUM / 论坛</Eyebrow>
          <CardTitle>{reply.post?.title || '正在整理帖子…'}</CardTitle>
          <CardDescription>
            {reply.post?.author} · {reply.post?.time}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Prose text={reply.post?.content} />
          <div className="flex flex-wrap gap-2">
            {reply.post?.tags?.map((tag, i) => (
              <Badge variant="secondary" key={i}>
                {tag}
              </Badge>
            ))}
          </div>
        </CardContent>
        <CardFooter className="flex flex-wrap justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {reply.post?.views ?? 0} 浏览 · {reply.post?.followers ?? 0} 关注 · {answers.length}{' '}
            条回答
          </span>
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => {
              setTarget('新帖')
              setText('')
              setTitle('')
            }}
          >
            <PenLine />
            发布帖子
          </Button>
        </CardFooter>
      </Card>
      <ol className="flex flex-col gap-3">
        {answers.slice(0, shown).map(
          (answer, i) =>
            answer && (
              <li key={answer.id || i}>
                <Card size="sm">
                  <CardHeader>
                    <CardTitle>{answer.author}</CardTitle>
                    <CardDescription>
                      {answer.time}
                      {answer.replyTo &&
                        ` · 回复 ${answers.find((a) => a?.id === answer.replyTo)?.author ?? '帖子'}`}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Prose text={answer.content} />
                  </CardContent>
                  <CardFooter className="flex justify-between gap-2">
                    <span className="text-xs text-muted-foreground">{answer.likes ?? 0} 赞同</span>
                    <Button
                      variant="ghost"
                      disabled={disabled || !onReply}
                      onClick={() => {
                        setTarget(answer.id || '')
                        setText('')
                      }}
                    >
                      <MessageSquare />
                      回复
                    </Button>
                  </CardFooter>
                </Card>
              </li>
            ),
        )}
      </ol>
      {answers.length > shown && (
        <Button variant="outline" onClick={() => setShown((s) => s + 10)}>
          展开更多回答（还有 {answers.length - shown} 条）
        </Button>
      )}
      <Dialog open={target !== null} onOpenChange={(v) => !v && setTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {target === '新帖'
                ? '发布帖子'
                : `回复 ${answers.find((a) => a?.id === target)?.author ?? '回答'}`}
            </DialogTitle>
            <DialogDescription>
              {target === '新帖'
                ? '生成新帖子和完整50条回答。'
                : '保存你的原文，并追加一条关联这条回答的 NPC 回复。'}
            </DialogDescription>
          </DialogHeader>
          {target === '新帖' && (
            <Field>
              <FieldLabel htmlFor="forum-title">帖子标题</FieldLabel>
              <Textarea
                id="forum-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                rows={2}
              />
            </Field>
          )}
          <Field>
            <FieldLabel htmlFor="forum-reply">内容</FieldLabel>
            <Textarea
              id="forum-reply"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={4}
            />
          </Field>
          <DialogFooter>
            <Button
              disabled={!text.trim() || (target === '新帖' && !title.trim()) || disabled}
              onClick={() => {
                if (target === '新帖') onSend(`$发送帖子\n标题：${title}\n${text}`)
                else if (target) onReply?.(target, text)
                setTarget(null)
              }}
            >
              发送
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
