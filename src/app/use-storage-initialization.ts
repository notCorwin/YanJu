import { useEffect, useState } from 'react'
import { friendlyError } from '@/lib/provider'
import { importSave, initializeStorage } from '@/lib/storage'

export function useStorageInitialization() {
  const [ready, setReady] = useState(false)
  const [failure, setFailure] = useState('')
  useEffect(() => {
    void initializeStorage()
      .then(() => setReady(true))
      .catch((error) => setFailure(friendlyError(error)))
  }, [])
  const restore = async (data: unknown) => {
    await importSave(data)
    await initializeStorage()
    setFailure('')
    setReady(true)
  }
  return { ready, failure, restore }
}
