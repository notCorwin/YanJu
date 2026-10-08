import { useEffect, useState } from 'react'
import { resolveBackground } from './background-storage'
import type { BackgroundImageRef } from './types'

export function useBackground(image: string | undefined, ref: BackgroundImageRef | undefined) {
  const id = ref?.id
  const mimeType = ref?.mimeType
  const size = ref?.size
  const key = id ? `${id}:${mimeType}:${size}` : image
  const [resolved, setResolved] = useState<{ key?: string; url: string; error?: Error }>({
    url: '',
  })
  useEffect(() => {
    if (!id || mimeType === undefined || size === undefined) return
    let active = true
    let url: string | undefined
    void resolveBackground({ id, mimeType, size })
      .then((blob) => {
        if (!active) return
        url = URL.createObjectURL(blob)
        setResolved({ key, url })
      })
      .catch((error: Error) => {
        if (active) setResolved({ key, url: '', error })
      })
    return () => {
      active = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [id, mimeType, size, key])
  return id ? (resolved.key === key ? resolved : { url: '' }) : { url: image ?? '' }
}
