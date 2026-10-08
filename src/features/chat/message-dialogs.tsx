import { ConfirmDialog } from '@/components/shared'
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

import type { ChatSessionState } from './use-chat-session'

export function MessageDialogs({ session }: { session: ChatSessionState }) {
  const {
    editing,
    setEditing,
    editText,
    setEditText,
    saveEdit,
    regenId,
    setRegenId,
    retry,
    clear,
    setClear,
    clearArchive,
  } = session
  return (
    <>
      <Dialog open={editing !== null} onOpenChange={(v) => !v && setEditing(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:page-width">
          <DialogHeader>
            <DialogTitle>编辑消息</DialogTitle>
            <DialogDescription>
              {editing?.reply
                ? '回复保存为 JSON 内容。修改后会检查结构；已覆盖这条消息的摘要会失效并在需要时重建。'
                : '修改后保留这条消息的时间和所属存档；相关摘要会自动失效。'}
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="edit-message">消息内容</FieldLabel>
            <Textarea
              id="edit-message"
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              rows={12}
            />
          </Field>
          <DialogFooter>
            <Button disabled={!editText.trim()} onClick={() => void saveEdit()}>
              保存修改
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!regenId}
        onClose={() => setRegenId('')}
        title="从这里重新生成？"
        detail="成功后替换这条回复及其后续内容。生成失败或取消会保留原聊天，并保存收到的部分内容。"
        destructive={false}
        onConfirm={() => {
          void retry(regenId)
        }}
      />
      <ConfirmDialog
        open={clear}
        onClose={() => setClear(false)}
        title="清空当前聊天？"
        detail="将删除当前篇章的聊天和摘要，并恢复原开场白。其他存档保留。"
        onConfirm={clearArchive}
      />
    </>
  )
}
