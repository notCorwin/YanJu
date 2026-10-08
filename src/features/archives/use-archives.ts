import { friendlyError } from '@/lib/provider'
import {
  createArchive,
  db,
  exportSave,
  importSave,
  normalizeImport,
  removeArchive,
  renameArchive as saveArchiveName,
} from '@/lib/storage'
import type { Notify } from '@/lib/types'
import { useRef, useState } from 'react'

export function useArchives({
  activeId,
  onSelect,
  onClose,
  notify,
}: {
  activeId: string
  onSelect: (id: string) => void
  onClose: () => void
  notify: Notify
}) {
  const [removeId, setRemoveId] = useState('')
  const [renameId, setRenameId] = useState('')
  const [name, setName] = useState('')
  const [pendingImport, setPendingImport] = useState<unknown>(null)
  const importRef = useRef<HTMLInputElement>(null)
  const download = async () => {
    try {
      const data = await exportSave()
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      )
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `盐焗-v3-${new Date().toISOString().slice(0, 10)}.json`
      anchor.click()
      URL.revokeObjectURL(url)
      notify('全部存档、人设、渠道和外观已导出。')
    } catch (e) {
      notify(friendlyError(e), true)
    }
  }
  const readImport = async (file: File) => {
    try {
      const value: unknown = JSON.parse(await file.text())
      normalizeImport(value)
      setPendingImport(value)
    } catch (e) {
      notify(friendlyError(e), true)
    }
  }
  const addArchive = async () => {
    try {
      onSelect((await createArchive()).id)
      onClose()
    } catch (e) {
      notify(friendlyError(e), true)
    }
  }
  const deleteArchive = async () => {
    const next = await removeArchive(removeId)
    if (removeId === activeId) onSelect(next?.id || (await createArchive()).id)
  }
  const renameArchive = async () => {
    try {
      await saveArchiveName(renameId, name)
      setRenameId('')
    } catch (e) {
      notify(friendlyError(e), true)
    }
  }
  const confirmImport = async () => {
    const data = await importSave(pendingImport)
    await db.persistence.flush()
    onSelect(data.settings.activeArchiveId || (await createArchive()).id)
    notify('存档导入完成。渠道须重新测试。')
    onClose()
  }
  return {
    removeId,
    setRemoveId,
    renameId,
    setRenameId,
    name,
    setName,
    pendingImport,
    setPendingImport,
    importRef,
    download,
    readImport,
    addArchive,
    deleteArchive,
    renameArchive,
    confirmImport,
  }
}

export type ArchiveActions = ReturnType<typeof useArchives>
