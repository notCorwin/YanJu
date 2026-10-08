import { Eyebrow, Prose } from '@/components/shared'
import { AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Message, MessageContent, MessageHeader } from '@/components/ui/message'
import type { NarrativeReply } from '@/lib/schemas'
import type { DeepPartial } from 'ai'

import { Section } from './section'

export function PhonePanel({ phone }: { phone: DeepPartial<NarrativeReply['phone']> | undefined }) {
  if (!phone) return null
  return (
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
              {phone.memos?.map((memo, i) => (
                <li key={i}>
                  <Prose text={memo} />
                </li>
              ))}
            </ul>
          </Section>
          <Section title="今日推送">
            <div className="grid gap-3 sm:grid-cols-2">
              {phone.recommendations?.map(
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
              {phone.purchases?.map(
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
            {phone.conversations?.map(
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
  )
}
