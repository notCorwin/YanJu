import { ConfirmDialog, Eyebrow, FormField, Prose } from '@/components/shared'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { FieldGroup } from '@/components/ui/field'
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes'
import type { ForumReply } from '@/lib/schemas'
import type { DeepPartial } from 'ai'
import { MessageSquare, PenLine } from 'lucide-react'
import { useRef, useState } from 'react'

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
  const [target, setTarget] = useState<
    { kind: 'post' } | { kind: 'reply'; id: string; author: string } | null
  >(null)
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
    if (isNewPost) onSend(`$发送帖子\n标题：${title}\n${text}`)
    else if (target?.kind === 'reply' && onReply) onReply(target.id, text)
    else return
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
            {reply.post?.views ?? 0} 浏览 · {reply.post?.followers ?? 0} 关注 · {answers.length}{' '}
            条回答
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
                      disabled={disabled || !onReply || !answer.id}
                      onClick={() => {
                        setErrors({})
                        setTarget({
                          kind: 'reply',
                          id: answer.id || '',
                          author: answer.author || '匿名',
                        })
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
            <DialogDescription>
              {isNewPost
                ? '生成新帖子和完整 50 条回答。'
                : '保存你的原文，并追加一条关联这条回答的 NPC 回复。'}
            </DialogDescription>
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
