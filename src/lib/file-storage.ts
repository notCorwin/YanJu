export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('图片读取失败，请重试。'))
    reader.readAsDataURL(blob)
  })
}

export function dataUrlToImage(value: string): Blob | undefined {
  const match = /^data:(image\/[\w.+-]+)((?:;[^,]*)?),(.*)$/is.exec(value)
  if (!match) return undefined
  try {
    const parameters = match[2].split(';').filter((part) => part && part !== 'base64')
    const mimeType = [match[1], ...parameters].join(';')
    const bytes = match[2].split(';').includes('base64')
      ? Uint8Array.from(atob(decodeURIComponent(match[3])), (char) => char.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(match[3]))
    return new Blob([bytes], { type: mimeType })
  } catch {
    return undefined
  }
}
