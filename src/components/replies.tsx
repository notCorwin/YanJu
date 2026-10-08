import { useRef, useState } from 'react'
import type { DeepPartial } from 'ai'
import type { ForumReply, NarrativeReply } from '@/lib/schemas'
import type { LegacyContent } from '@/lib/types'
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
import { FieldGroup } from './ui/field'
import { Eyebrow, Prose, FormField, ConfirmDialog } from './shared'
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes'
import { MessageSquare, PenLine } from 'lucide-react'

type Scene = DeepPartial<NarrativeReply['scene']>
function SceneCard({ scene }: { scene: Scene }) {
  return (
    <Card size="sm">
      <CardHeader>
        <Eyebrow>SCENE / 场景</Eyebrow>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {[
            ['时间', scene.time],
            ['地点', scene.location],
            ['在场', scene.characters?.filter(Boolean).join('、')],
          ].map(([name, value]) => (
            <div key={name} className="min-w-0 first:col-span-2 sm:first:col-span-1">
              <p className="text-xs text-muted-foreground">{name}</p>
              <p className="wrap-anywhere text-ui">{value || '…'}</p>
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
export function NarrativeView({ reply }: { reply: DeepPartial<NarrativeReply> }) {
  return (
    <div className="flex flex-col gap-6">
      {reply.scene && <SceneCard scene={reply.scene} />}
      <div className="flex flex-col gap-5">
        {reply.blocks?.map(
          (block, i) =>
            block && (
              <div
                key={i}
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
                  距求婚还有 {reply.diary.countdownDays ?? '…'} 天
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
  disabled,
}: {
  reply: DeepPartial<ForumReply>
  onSend: (text: string) => void
  disabled?: boolean
}) {
  const [target, setTarget] = useState<{ kind: 'post' } | { kind: 'reply'; author: string } | null>(
    null,
  )
  const [text, setText] = useState('')
  const [title, setTitle] = useState('')
  const [errors, setErrors] = useState<{ title?: string; text?: string }>({})
  const formRef = useRef<HTMLFormElement>(null)
  const isNewPost = target?.kind === 'post'
  const { guard, confirmation } = useUnsavedChanges(target !== null && !!(text || title))
  const submit = () => {
    if (disabled) return
    const issues = {
      title: isNewPost && !title.trim() ? '请输入帖子标题。' : undefined,
      text: !text.trim() ? '请输入内容。' : undefined,
    }
    setErrors(issues)
    if (issues.title || issues.text) {
      requestAnimationFrame(() =>
        formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      )
      return
    }
    onSend(
      isNewPost
        ? `$发送帖子\n标题：${title.trim()}\n${text.trim()}`
        : `回复${target?.kind === 'reply' ? target.author : '匿名'}：${text.trim()}`,
    )
    setTarget(null)
  }
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
            {reply.post?.views ?? 0} 浏览 · {reply.post?.followers ?? 0} 关注 · {answers.length}/50
            回答
          </span>
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => {
              setErrors({})
              setTarget({ kind: 'post' })
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
                      {answer.replyTo && ` · 回复 ${answer.replyTo}`}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Prose text={answer.content} />
                  </CardContent>
                  <CardFooter className="flex justify-between gap-2">
                    <span className="text-xs text-muted-foreground">{answer.likes ?? 0} 赞同</span>
                    <Button
                      variant="ghost"
                      disabled={disabled}
                      onClick={() => {
                        setErrors({})
                        setTarget({ kind: 'reply', author: answer.author || '匿名' })
                        setText('')
                        setTitle('')
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
      <Dialog open={target !== null} onOpenChange={(v) => !v && guard(() => setTarget(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {isNewPost ? '发布帖子' : `回复 ${target?.kind === 'reply' ? target.author : ''}`}
            </DialogTitle>
            <DialogDescription>发送后由当前渠道生成完整论坛内容和 50 条回答。</DialogDescription>
          </DialogHeader>
          <form
            ref={formRef}
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              submit()
            }}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                (e.ctrlKey || e.metaKey) &&
                !e.nativeEvent.isComposing &&
                e.keyCode !== 229
              ) {
                e.preventDefault()
                submit()
              }
            }}
          >
            <FieldGroup>
              {isNewPost && (
                <FormField
                  label="帖子标题"
                  name="forum-title"
                  value={title}
                  error={errors.title}
                  onChange={(value) => {
                    setTitle(value)
                    setErrors((previous) => ({ ...previous, title: undefined }))
                  }}
                  autoFocus
                />
              )}
              <FormField
                label="内容"
                name="forum-content"
                value={text}
                error={errors.text}
                multiline
                autoFocus={!isNewPost}
                onChange={(value) => {
                  setText(value)
                  setErrors((previous) => ({ ...previous, text: undefined }))
                }}
                help="⌘ / Ctrl + Enter 发送"
              />
            </FieldGroup>
            <DialogFooter>
              <Button type="submit" disabled={disabled}>
                发送
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        {...confirmation}
        title="放弃未发送的内容？"
        detail="帖子或回复还没有发送，可以取消返回继续编辑。"
        confirmLabel="放弃内容"
        destructive={false}
      />
    </div>
  )
}
export function LegacyView({
  value,
  onSend,
  disabled,
}: {
  value: LegacyContent
  onSend: (text: string) => void
  disabled?: boolean
}) {
  if (value.forum) return <ForumView reply={value.forum} onSend={onSend} disabled={disabled} />
  return (
    <div className="flex flex-col gap-6">
      {value.scene && (
        <SceneCard scene={{ ...value.scene, characters: [value.scene.characters] }} />
      )}
      <Prose text={value.body} />
      {value.panels.length > 0 && (
        <Accordion type="multiple">
          {value.panels.map((p, i) => (
            <AccordionItem value={String(i)} key={i}>
              <AccordionTrigger>{p.title}</AccordionTrigger>
              <AccordionContent>
                <div className="flex flex-col gap-5 py-3">
                  {p.sections.map((s, j) => (
                    <Section key={j} title={s.heading}>
                      <Prose text={s.text} />
                    </Section>
                  ))}
                </div>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      )}
    </div>
  )
}
