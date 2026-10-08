import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldLabel } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import { useState } from 'react'

export function ForumComposer({
  target,
  onClose,
  onSend,
  disabled,
}: {
  target: string | null
  onClose: () => void
  onSend: (text: string) => void
  disabled?: boolean
}) {
  const [text, setText] = useState('')
  const [title, setTitle] = useState('')
  return (
    <Dialog open={target !== null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{target === '新帖' ? '发布帖子' : `回复 ${target}`}</DialogTitle>
          <DialogDescription>发送后由当前渠道生成完整论坛内容和 50 条回答。</DialogDescription>
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
              onSend(
                target === '新帖' ? `$发送帖子\n标题：${title}\n${text}` : `回复${target}：${text}`,
              )
              onClose()
            }}
          >
            发送
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
