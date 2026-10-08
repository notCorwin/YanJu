import { useEffect, useState, useSyncExternalStore } from 'react'
import { db } from './db'

export function useStorageQuery<T>(query: () => Promise<T>) {
  const revision = useSyncExternalStore(db.subscribe, db.getRevision, db.getRevision)
  const [result, setResult] = useState<{ query?: typeof query; data?: T; error?: Error }>({})
  useEffect(() => {
    let active = true
    void query().then(
      (data) => {
        if (active) setResult({ query, data })
      },
      (error: Error) => {
        if (active) setResult({ query, error })
      },
    )
    return () => {
      active = false
    }
  }, [query, revision])
  return result.query === query ? result : {}
}
