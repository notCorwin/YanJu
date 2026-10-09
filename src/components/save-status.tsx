import { useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { db, exportSave } from '@/lib/storage'
import { downloadJson, saveFileName } from '@/lib/download'
import { friendlyError } from '@/lib/provider'
import type { Notify } from '@/lib/notify'
import {
  draftSaveError,
  subscribeDrafts,
  retryDrafts,
  withPendingDrafts,
} from '@/lib/draft-storage'

export function SaveStatus({ notify }: { notify: Notify }) {
  const storage = useSyncExternalStore(db.persistence.subscribe, db.persistence.getStatus)
  const draftError = useSyncExternalStore(subscribeDrafts, draftSaveError)
  const error =
    draftError || (storage.phase === 'error' ? storage.error || '保存失败，请重试。' : undefined)
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span
        className="truncate"
        title="自动保存 · Enter 发送，Shift + Enter 换行"
        role={error ? 'alert' : 'status'}
      >
        {error
          ? `保存未完成：${error}`
          : storage.phase === 'saved' || storage.phase === 'unavailable'
            ? '已自动保存'
            : '正在保存…'}
      </span>
      {error && (
        <>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void retryDrafts()
                .then(() => db.persistence.flush())
                .catch((error) => notify(friendlyError(error), true))
            }
          >
            重试保存
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void exportSave()
                .then((data) => downloadJson(withPendingDrafts(data), saveFileName()))
                .catch((error) => notify(friendlyError(error), true))
            }
          >
            导出备份
          </Button>
        </>
      )}
    </div>
  )
}
