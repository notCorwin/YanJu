import type { Notify } from '@/lib/types'
import { useCallback } from 'react'
import { toast } from 'sonner'

export function useNotify(): Notify {
  return useCallback((message, error = false) => {
    if (error) toast.error(message, { duration: 12000 })
    else toast(message)
  }, [])
}
