import { Button } from '@/components/ui/button'
import { useStorageStatus } from './use-storage-status'

export function StorageStatus() {
  const { storage, retry } = useStorageStatus()
  return (
    <>
      <span className="block" role={storage.phase === 'error' ? 'alert' : 'status'}>
        {storage.phase === 'saved'
          ? storage.persistent
            ? '已同步 OPFS 存档 · 已获准持久保存'
            : '已同步 OPFS 存档 · 可导出备份'
          : storage.phase === 'error'
            ? `OPFS 同步失败：${storage.error}。资料保留在浏览器数据库中，可导出或重试。`
            : storage.phase === 'unavailable'
              ? '当前浏览器不支持 OPFS，资料已使用浏览器数据库保存。'
              : '正在同步 OPFS 存档…'}
      </span>
      {storage.phase === 'error' && (
        <Button variant="outline" onClick={retry}>
          重试存档同步
        </Button>
      )}
    </>
  )
}
