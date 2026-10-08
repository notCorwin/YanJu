import { IconButton } from '@/components/shared'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { type Archive, type Notify } from '@/lib/types'
import { Download, PenLine, Plus, Trash2, Upload } from 'lucide-react'
import { ArchivesDialogs } from './archives-dialogs'
import { StorageStatus } from './storage-status'
import { useArchives } from './use-archives'

const formatDate = (value: number) => new Date(value).toLocaleString('zh-CN', { hour12: false })

export function ArchivesSheet({
  open,
  onClose,
  archives,
  activeId,
  onSelect,
  notify,
  disabled,
}: {
  open: boolean
  onClose: () => void
  archives: Archive[]
  activeId: string
  onSelect: (id: string) => void
  notify: Notify
  disabled: boolean
}) {
  const actions = useArchives({ activeId, onSelect, onClose, notify })
  const { setRemoveId, setRenameId, setName, importRef, download, readImport, addArchive } = actions
  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full sm:panel-width">
        <SheetHeader>
          <SheetTitle>存档</SheetTitle>
          <SheetDescription>
            每个篇章独立保存完整聊天与压缩摘要。
            <StorageStatus />
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-wrap gap-2 px-4">
          <Button disabled={disabled} onClick={() => void addArchive()}>
            <Plus data-icon="inline-start" />
            新建
          </Button>
          <Button variant="outline" onClick={() => void download()}>
            <Download data-icon="inline-start" />
            导出全部
          </Button>
          <Button variant="outline" disabled={disabled} onClick={() => importRef.current?.click()}>
            <Upload data-icon="inline-start" />
            导入
          </Button>
          <input
            ref={importRef}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            aria-label="导入存档文件"
            onChange={async (e) => {
              const file = e.target.files?.[0]
              if (!file) return
              await readImport(file)
              e.target.value = ''
            }}
          />
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          {archives.map((a) => (
            <Card key={a.id} size="sm">
              <CardHeader>
                <CardTitle>{a.name}</CardTitle>
                <CardDescription>
                  {formatDate(a.updatedAt)}
                  {a.summary && ' · 已压缩上下文'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap items-center gap-1">
                  <Button
                    disabled={disabled}
                    variant={a.id === activeId ? 'secondary' : 'outline'}
                    onClick={() => {
                      onSelect(a.id)
                      onClose()
                    }}
                  >
                    {a.id === activeId ? '当前存档' : '载入'}
                  </Button>
                  <IconButton
                    label={`重命名 ${a.name}`}
                    disabled={disabled}
                    onClick={() => {
                      setRenameId(a.id)
                      setName(a.name)
                    }}
                  >
                    <PenLine data-icon="inline-start" />
                  </IconButton>
                  <IconButton
                    label={`删除 ${a.name}`}
                    disabled={disabled}
                    variant="destructive"
                    onClick={() => setRemoveId(a.id)}
                  >
                    <Trash2 data-icon="inline-start" />
                  </IconButton>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
        <ArchivesDialogs actions={actions} />
      </SheetContent>
    </Sheet>
  )
}
