import { useEffect, useState } from 'react'
import { dataUrlToImage } from './file-storage'

export function useBackground(image: string | undefined) {
  const [resolved, setResolved] = useState<{ image?: string; url: string }>({ url: '' })
  useEffect(() => {
    let active = true
    let url: string | undefined
    void Promise.resolve().then(() => {
      if (!active) return
      const blob = image ? dataUrlToImage(image) : undefined
      if (!blob) return
      url = URL.createObjectURL(blob)
      setResolved({ image, url })
    })
    return () => {
      active = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [image])
  return resolved.image === image ? resolved.url : image ?? ''
}
