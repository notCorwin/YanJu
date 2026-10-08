export function downloadJson(value: unknown, name: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
  )
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const saveFileName = (name = '盐焗') =>
  `${name.replace(/[\\/:*?"<>|]/g, '-')}-${new Date().toLocaleDateString('sv-SE')}.json`
