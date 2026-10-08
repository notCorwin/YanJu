import { db } from '@/lib/storage'
import { useSyncExternalStore } from 'react'

export function useStorageStatus() {
  const storage = useSyncExternalStore(db.persistence.subscribe, db.persistence.getStatus)
  return { storage, retry: () => void db.persistence.flush() }
}
