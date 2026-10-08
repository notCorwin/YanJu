import { useState } from 'react'
import { ConfirmDialog } from '@/components/shared'
import { Button } from '@/components/ui/button'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { friendlyError } from '@/lib/provider'
import { normalizeImport } from '@/lib/storage'

export function InitializationScreen({
  failure,
  restore,
}: {
  failure: string
  restore: (data: unknown) => Promise<void>
}) {
  const [pending, setPending] = useState<unknown>(null)
  const [error, setError] = useState('')
  if (!failure)
    return (
      <main className="flex chat-height items-center justify-center text-primary" role="status">
        宴雎 · 正在打开篇章…
      </main>
    )
  return (
    <main className="mx-auto flex page-width flex-col gap-6 p-8">
      <h1 className="text-xl">本地资料尚未打开</h1>
      <p role="alert">{error || failure}</p>
      <p>请确认浏览器允许本地存储，或导入完整 JSON 存档恢复资料。</p>
      <Button className="w-fit" onClick={() => location.reload()}>
        重新载入
      </Button>
      <Field>
        <FieldLabel htmlFor="recovery-file">导入存档恢复资料</FieldLabel>
        <Input
          id="recovery-file"
          type="file"
          accept="application/json,.json"
          aria-label="恢复存档文件"
          onChange={async (event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (!file) return
            try {
              const data: unknown = JSON.parse(await file.text())
              normalizeImport(data)
              setError('')
              setPending(data)
            } catch (cause) {
              setError(friendlyError(cause))
            }
          }}
        />
      </Field>
      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title="导入并替换当前资料？"
        detail="导入会替换当前浏览器的全部资料。"
        onConfirm={() => restore(pending)}
      />
    </main>
  )
}
