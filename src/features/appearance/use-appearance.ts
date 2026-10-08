import { friendlyError } from '@/lib/provider'
import { updateSettings } from '@/lib/storage'
import type { Appearance, Notify } from '@/lib/types'

export function useAppearance(notify: Notify) {
  const update = (key: keyof Appearance, value: string | number) =>
    void updateSettings({ [key]: value }).catch((e) => notify(friendlyError(e), true))
  const upload = async (file: File | undefined) => {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      notify('请选择图片文件。', true)
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') update('bgImage', reader.result)
    }
    reader.onerror = () => notify('图片读取失败，请重试。', true)
    reader.readAsDataURL(file)
  }
  return { update, upload }
}
