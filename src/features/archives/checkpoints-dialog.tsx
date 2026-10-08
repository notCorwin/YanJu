import { ConfirmDialog, IconButton } from '@/components/shared'
import { Button } from '@/components/ui/button'
import { Card, CardFooter, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@/components/ui/empty'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  createCheckpoint,
  deleteCheckpoint,
  importCheckpoint,
  listCheckpoints,
  readCheckpoint,
  restoreCheckpoint,
  type CheckpointInfo,
} from '@/lib/checkpoints'
import { downloadJson, saveFileName } from '@/lib/download'
import { formatDate } from '@/lib/format-date'
import type { Notify } from '@/lib/notify'
import { friendlyError } from '@/lib/provider'
import { Download, LoaderCircle, Plus, Trash2, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

export function CheckpointsDialog({
  open,
  onClose,
  disabled,
  notify,
  archiveName,
  onRestore,
}: {
  open: boolean
  onClose: () => void
  disabled: boolean
  notify: Notify
  archiveName: string
  onRestore: (id: string) => void
}) {
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [restore, setRestore] = useState('')
  const [remove, setRemove] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!open) return
    let active = true
    void listCheckpoints()
      .then((items) => {
        if (active) {
          setCheckpoints(items)
          setError('')
        }
      })
      .catch((e) => {
        if (active) setError(friendlyError(e))
      })
    return () => {
      active = false
    }
  }, [open])
  const run = async (operation: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    try {
      await operation()
      setCheckpoints(await listCheckpoints())
      setError('')
    } catch (e) {
      setError(friendlyError(e))
      notify(friendlyError(e), true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && !busy) onClose()
      }}
    >
      <DialogContent size="wide" className="editor-height overflow-hidden">
        <DialogHeader>
          <DialogTitle>Checkpoint</DialogTitle>
          <DialogDescription>
            在 OPFS 中保存完整剧情、任务、人设、渠道和外观的独立快照。导入后可选择恢复。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={disabled || busy || !!error}
            onClick={() =>
              void run(async () => {
                await createCheckpoint(`${archiveName} · ${new Date().toLocaleString('zh-CN')}`)
                notify('Checkpoint 已保存在 OPFS。')
              })
            }
          >
            {busy ? (
              <LoaderCircle data-icon="inline-start" className="animate-spin" />
            ) : (
              <Plus data-icon="inline-start" />
            )}
            创建 Checkpoint
          </Button>
          <Button
            variant="outline"
            disabled={busy || disabled}
            onClick={() => input.current?.click()}
          >
            <Upload data-icon="inline-start" />
            导入 Checkpoint
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void run(async () => undefined)}>
            刷新
          </Button>
          <input
            ref={input}
            type="file"
            accept="application/json,.json"
            aria-label="导入 Checkpoint 文件"
            className="sr-only"
            onChange={(e) => {
              const file = e.currentTarget.files?.[0]
              e.currentTarget.value = ''
              if (file)
                void run(async () => {
                  await importCheckpoint(JSON.parse(await file.text()))
                  notify('Checkpoint 已导入 OPFS，当前剧情保留。')
                })
            }}
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
          {!checkpoints.length && !error && (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>暂无 Checkpoint</EmptyTitle>
                <EmptyDescription>创建后可随时恢复，也可导入之前导出的快照。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          {checkpoints.map((checkpoint) => (
            <Card key={checkpoint.id}>
              <CardHeader>
                <CardTitle>{checkpoint.name}</CardTitle>
                <CardDescription>{formatDate(checkpoint.createdAt)}</CardDescription>
              </CardHeader>
              <CardFooter className="flex-wrap gap-2">
                <Button
                  variant="secondary"
                  disabled={disabled || busy}
                  onClick={() => setRestore(checkpoint.id)}
                >
                  恢复
                </Button>
                <IconButton
                  label={`导出 Checkpoint ${checkpoint.name}`}
                  disabled={busy}
                  onClick={() =>
                    void run(async () =>
                      downloadJson(
                        await readCheckpoint(checkpoint.id),
                        saveFileName(`checkpoint-${checkpoint.name}`),
                      ),
                    )
                  }
                >
                  <Download />
                </IconButton>
                <IconButton
                  label={`删除 Checkpoint ${checkpoint.name}`}
                  disabled={busy || disabled}
                  variant="ghost"
                  onClick={() => setRemove(checkpoint.id)}
                >
                  <Trash2 />
                </IconButton>
              </CardFooter>
            </Card>
          ))}
        </div>
        <ConfirmDialog
          open={!!remove}
          onClose={() => setRemove('')}
          title="删除 Checkpoint？"
          detail="删除 OPFS 中的这份快照，当前剧情保留。"
          onConfirm={async () => {
            setBusy(true)
            try {
              await deleteCheckpoint(remove)
              setCheckpoints(await listCheckpoints())
              setError('')
            } finally {
              setBusy(false)
            }
          }}
        />
        <ConfirmDialog
          open={!!restore}
          onClose={() => setRestore('')}
          title="恢复 Checkpoint？"
          detail="将当前全部资料替换为此快照。可先创建新的 Checkpoint 保留当前进度。"
          onConfirm={async () => {
            setBusy(true)
            try {
              const { data, persistence } = await restoreCheckpoint(restore)
              onRestore(data.settings.activeArchiveId)
              notify(
                persistence.phase === 'error'
                  ? `Checkpoint 已恢复，但自动存档同步失败：${persistence.error}`
                  : 'Checkpoint 已恢复，渠道须重新测试。',
                persistence.phase === 'error',
              )
              onClose()
            } finally {
              setBusy(false)
            }
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
