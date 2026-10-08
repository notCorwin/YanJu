import { ConfirmDialog, FormField } from '@/components/shared'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

import type { ArchiveActions } from './use-archives'

export function ArchivesDialogs({ actions }: { actions: ArchiveActions }) {
  const {
    removeId,
    setRemoveId,
    renameId,
    setRenameId,
    name,
    setName,
    pendingImport,
    setPendingImport,
    deleteArchive,
    renameArchive,
    confirmImport,
  } = actions
  return (
    <>
      <ConfirmDialog
        open={!!removeId}
        onClose={() => setRemoveId('')}
        title="删除存档？"
        detail="将删除这个篇章的全部消息和摘要。建议先导出。"
        onConfirm={deleteArchive}
      />
      <Dialog open={!!renameId} onOpenChange={(v) => !v && setRenameId('')}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重命名存档</DialogTitle>
            <DialogDescription>为这个篇章取一个名字。</DialogDescription>
          </DialogHeader>
          <FormField label="存档名称" value={name} onChange={setName} />
          <Button disabled={!name.trim()} onClick={() => void renameArchive()}>
            保存名称
          </Button>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={pendingImport !== null}
        onClose={() => setPendingImport(null)}
        title="导入并替换当前资料？"
        detail="已经校验文件。导入会替换当前浏览器的全部存档、人设、渠道和设置；可先取消并导出。"
        onConfirm={confirmImport}
      />
    </>
  )
}
