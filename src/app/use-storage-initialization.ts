import { friendlyError } from '@/lib/provider'
import { initializeStorage } from '@/lib/storage'
import { useEffect, useState } from 'react'

export function useStorageInitialization() {
  const [ready, setReady] = useState(false)
  const [failure, setFailure] = useState('')
  useEffect(() => {
    void initializeStorage()
      .then(() => setReady(true))
      .catch((e) => setFailure(friendlyError(e)))
  }, [])
  return { ready, failure }
}
