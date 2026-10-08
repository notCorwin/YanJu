import { Eyebrow, Prose } from '@/components/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import type { ForumReply } from '@/lib/schemas'
import type { DeepPartial } from 'ai'
import { MessageSquare, PenLine } from 'lucide-react'
import { useState } from 'react'

import { ForumComposer } from './forum-composer'

export function ForumView({
  reply,
  onSend,
  disabled,
}: {
  reply: DeepPartial<ForumReply>
  onSend: (text: string) => void
  disabled?: boolean
}) {
  const [target, setTarget] = useState<string | null>(null)
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
              setTarget('新帖')
            }}
          >
            <PenLine data-icon="inline-start" />
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
                        setTarget(answer.author || '匿名')
                      }}
                    >
                      <MessageSquare data-icon="inline-start" />
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
      <ForumComposer
        key={target ?? 'closed'}
        target={target}
        onClose={() => setTarget(null)}
        onSend={onSend}
        disabled={disabled}
      />
    </div>
  )
}
