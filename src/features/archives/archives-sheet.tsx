import { withPendingDrafts } from '@/lib/draft-storage'
import { GameSavesDialog } from './game-saves-dialog'
import { importGame, parseGameShare } from '@/lib/game-share'
import { removeGameHistory } from '@/lib/game-history'
import { ConfirmDialog, FormField, IconButton } from '@/components/shared'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { downloadJson, saveFileName } from '@/lib/download'
import { formatDate } from '@/lib/format-date'
import type { Notify } from '@/lib/notify'
import { withArchiveOperation } from '@/lib/operations'
import { friendlyError } from '@/lib/provider'
import {
  createArchive,
  db,
  exportSave,
  importSave,
  initializeStorage,
  normalizeImport,
} from '@/lib/storage'
import { type Archive } from '@/lib/types'
import { Download, LoaderCircle, PenLine, Plus, Trash2, Upload } from 'lucide-react'
import { useRef, useState, useSyncExternalStore } from 'react'

export function ArchivesSheet({
  open,
  onClose,
  archives,
  activeId,
  onSelect,
  onRestored,
  notify,
  disabled,
}: {
  open: boolean
  onClose: () => void
  archives: Archive[]
  activeId: string
  onSelect: (id: string) => void
  onRestored: () => void
  notify: Notify
  disabled: boolean
}) {
  const [savesOpen, setSavesOpen] = useState(false)
  const [removeId, setRemoveId] = useState('')
  const [renameId, setRenameId] = useState('')
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [namePending, setNamePending] = useState(false)
  const [nameError, setNameError] = useState('')
  const [search, setSearch] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)
  const visibleArchives = archives.filter((archive) =>
    archive.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  )
  const [pendingImport, setPendingImport] = useState<unknown>(null)
  const [importMode, setImportMode] = useState<'replace' | 'merge'>('replace')
  const storage = useSyncExternalStore(db.persistence.subscribe, db.persistence.getStatus)
  const importRef = useRef<HTMLInputElement>(null)
  const download = async () => {
    try {
      const data = await exportSave()
      downloadJson(withPendingDrafts(data), saveFileName())
      notify('全部存档、人设、渠道和外观已导出。')
    } catch (e) {
      notify(friendlyError(e), true)
    }
  }
  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full overflow-hidden sm:panel-width safe-bottom">
        <SheetHeader>
          <SheetTitle>存档</SheetTitle>
          <SheetDescription>
            每个篇章独立保存完整聊天与压缩摘要。
            <span className="block" role={storage.phase === 'error' ? 'alert' : 'status'}>
              {storage.phase === 'saved'
                ? storage.persistent
                  ? '全部更改已保存 · 已获准持久保存'
                  : '全部更改已保存 · 可导出备份'
                : storage.phase === 'error'
                  ? `存档备份未完成：${storage.error}。资料保留在浏览器数据库中，可导出或重试。`
                  : storage.phase === 'unavailable'
                    ? '资料已保存在当前浏览器，建议定期导出备份。'
                    : '正在保存更改…'}
            </span>
          </SheetDescription>
          {storage.phase === 'error' && (
            <Button variant="outline" onClick={() => void db.persistence.flush()}>
              重试存档同步
            </Button>
          )}
        </SheetHeader>
        <div className="flex flex-wrap gap-2 px-4">
          <Button variant="outline" onClick={() => setSavesOpen(true)}>
            存档与路线
          </Button>
          <Button
            disabled={disabled}
            onClick={() => {
              setName('新的篇章')
              setNameError('')
              setCreating(true)
            }}
          >
            <Plus />
            新建
          </Button>
          <Button variant="outline" onClick={() => void download()}>
            <Download />
            导出全部
          </Button>
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => {
              setImportMode('replace')
              importRef.current?.click()
            }}
          >
            <Upload />
            导入
          </Button>
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => {
              setImportMode('merge')
              importRef.current?.click()
            }}
          >
            合并导入
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
              try {
                const value: unknown = JSON.parse(await file.text())
                if (
                  value &&
                  typeof value === 'object' &&
                  'format' in value &&
                  value.format === 'yanju-game'
                ) {
                  parseGameShare(value)
                  const imported = await importGame(value)
                  onRestored()
                  onSelect(imported.id)
                  notify('剧情已导入为独立篇章。')
                  onClose()
                } else {
                  normalizeImport(value)
                  setPendingImport(value)
                }
              } catch (err) {
                notify(friendlyError(err), true)
              }
              e.target.value = ''
            }}
          />
        </div>
        <div className="flex flex-col gap-2 px-4">
          <label htmlFor="archive-search" className="sr-only">
            搜索存档
          </label>
          <Input
            id="archive-search"
            type="search"
            placeholder="搜索篇章名称…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <p className="text-xs text-muted-foreground" role="status">
            {search.trim()
              ? `找到 ${visibleArchives.length} 个篇章`
              : `共 ${archives.length} 个篇章`}
          </p>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          {!visibleArchives.length && (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{search.trim() ? '没有找到匹配的篇章' : '还没有保存的篇章'}</EmptyTitle>
                <EmptyDescription>
                  {search.trim()
                    ? '换一个关键词，或查看全部存档。'
                    : '新建篇章开始聊天，也可以导入存档继续。'}
                </EmptyDescription>
              </EmptyHeader>
              {search.trim() && (
                <Button variant="outline" onClick={() => setSearch('')}>
                  查看全部存档
                </Button>
              )}
            </Empty>
          )}
          {visibleArchives.map((a) => (
            <Card key={a.id} size="sm" className="shrink-0">
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
                    label={`导出 ${a.name}`}
                    onClick={() => {
                      onSelect(a.id)
                      setSavesOpen(true)
                    }}
                  >
                    <Download />
                  </IconButton>
                  <IconButton
                    label={`重命名 ${a.name}`}
                    disabled={disabled}
                    onClick={() => {
                      setRenameId(a.id)
                      setName(a.name)
                      setNameError('')
                    }}
                  >
                    <PenLine />
                  </IconButton>
                  <IconButton
                    label={`删除 ${a.name}`}
                    disabled={disabled}
                    variant="ghost"
                    onClick={() => setRemoveId(a.id)}
                  >
                    <Trash2 />
                  </IconButton>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
        <GameSavesDialog
          open={savesOpen}
          onClose={() => setSavesOpen(false)}
          archiveId={activeId}
          notify={notify}
          onRestore={onRestored}
        />
        <ConfirmDialog
          open={!!removeId}
          onClose={() => setRemoveId('')}
          title="删除存档？"
          detail="将删除这个篇章的全部消息和摘要。建议先导出。"
          onConfirm={async () => {
            await withArchiveOperation(removeId, () =>
              db.transaction(
                'rw',
                [
                  ...db.gameTables,
                  db.messages,
                  db.archives,
                  db.storyStates,
                  db.storyEvents,
                  db.tasks,
                  db.requests,
                ],
                async () => {
                  await db.messages.where('archiveId').equals(removeId).delete()
                  await removeGameHistory(removeId)
                  await db.archives.delete(removeId)
                  await db.storyStates.delete(removeId)
                  await db.storyEvents.where('archiveId').equals(removeId).delete()
                  await db.tasks.where('archiveId').equals(removeId).delete()
                  await db.requests.where('archiveId').equals(removeId).delete()
                },
              ),
            )
            const next = await db.archives.toCollection().first()
            if (removeId === activeId) onSelect(next?.id || (await createArchive()).id)
          }}
        />
        <Dialog
          open={!!renameId || creating}
          onOpenChange={(v) => {
            if (!v && !namePending) {
              setRenameId('')
              setCreating(false)
            }
          }}
        >
          <DialogContent
            onEscapeKeyDown={(event) => namePending && event.preventDefault()}
            onInteractOutside={(event) => namePending && event.preventDefault()}
          >
            <DialogHeader>
              <DialogTitle>{creating ? '新建篇章' : '重命名存档'}</DialogTitle>
              <DialogDescription>为这个篇章取一个名字，方便下次找到它。</DialogDescription>
            </DialogHeader>
            <form
              className="flex flex-col gap-4"
              onSubmit={async (e) => {
                e.preventDefault()
                if (namePending) return
                if (!name.trim()) {
                  setNameError('请输入存档名称。')
                  nameRef.current?.focus()
                  return
                }
                setNamePending(true)
                try {
                  if (creating) {
                    const archive = await createArchive(name.trim())
                    onSelect(archive.id)
                    setCreating(false)
                    setSearch('')
                    onClose()
                  } else {
                    await withArchiveOperation(renameId, () =>
                      db.archives.update(renameId, { name: name.trim() }),
                    )
                    notify('存档名称已更新。')
                  }
                  setRenameId('')
                } catch (error) {
                  setNameError(friendlyError(error))
                } finally {
                  setNamePending(false)
                }
              }}
            >
              <FormField
                label="存档名称"
                ref={nameRef}
                name="archive-name"
                value={name}
                error={nameError}
                onChange={(value) => {
                  setName(value)
                  setNameError('')
                }}
                disabled={namePending}
                autoFocus
                onFocus={(event) => event.target.select()}
              />
              <Button type="submit" disabled={namePending}>
                {namePending && <LoaderCircle className="animate-spin" />}
                {creating ? '创建并进入聊天' : '保存名称'}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
        <ConfirmDialog
          open={pendingImport !== null}
          onClose={() => setPendingImport(null)}
          title={importMode === 'merge' ? '合并导入存档？' : '导入并替换当前资料？'}
          detail={
            importMode === 'merge'
              ? '已经校验文件。保留现有资料和外观设置；编号冲突的篇章会作为独立副本导入。'
              : '已经校验文件。导入会替换当前浏览器的全部存档、人设、渠道和设置；可先取消并导出。'
          }
          onConfirm={async () => {
            const data = await importSave(pendingImport, db, false, importMode)
            await initializeStorage()
            await db.persistence.flush()
            onRestored()
            onSelect(data.settings.activeArchiveId || (await createArchive()).id)
            notify('存档导入完成。渠道须重新测试。')
            onClose()
          }}
        />
      </SheetContent>
    </Sheet>
  )
}
