import { Eyebrow, Prose } from '@/components/shared'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Message, MessageContent, MessageHeader } from '@/components/ui/message'
import { SceneCard } from '@/features/chat/replies/scene-card'
import { Section } from '@/features/chat/replies/section'
import type { NarrativeReply } from '@/lib/schemas'
import type { DeepPartial } from 'ai'
import type { AnimationEvent } from 'react'

function revealExpandedPanel(event: AnimationEvent<HTMLDivElement>) {
  const content = event.currentTarget
  if (event.target === content && content.dataset.state === 'open')
    content.parentElement?.scrollIntoView({ block: 'start', inline: 'nearest' })
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
                className={block.kind === 'dialogue' ? 'edge-accent prose-highlight px-4 py-3' : ''}
              >
                <Prose text={block.text} />
                {block.kind === 'dialogue' && block.translation && (
                  <p className="mt-2 text-ui text-muted-foreground">「{block.translation}」</p>
                )}
              </div>
            ),
        )}
      </div>
      <Accordion type="multiple" className="accordion-panels">
        {reply.state && (
          <AccordionItem value="state">
            <AccordionTrigger>
              <span className="flex flex-col gap-1">
                <Eyebrow>STATE / INTERNAL</Eyebrow>
                <span>宴雎 · 此刻</span>
              </span>
            </AccordionTrigger>
            <AccordionContent onAnimationEnd={revealExpandedPanel}>
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
            <AccordionContent onAnimationEnd={revealExpandedPanel}>
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
            <AccordionContent onAnimationEnd={revealExpandedPanel}>
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
