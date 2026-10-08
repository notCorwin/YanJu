import { Button } from '@/components/ui/button'

export function InitializationScreen({ failure }: { failure: string }) {
  if (failure)
    return (
      <main className="mx-auto flex page-width flex-col gap-6 p-8">
        <h1 className="text-xl">本地资料尚未打开</h1>
        <p role="alert">{failure}</p>
        <p>请确认浏览器允许 IndexedDB，或重新载入后导入存档。</p>
        <Button className="w-fit" onClick={() => location.reload()}>
          重新载入
        </Button>
      </main>
    )
  return (
    <main className="flex chat-height items-center justify-center text-primary" role="status">
      盐焗 · 正在打开篇章…
    </main>
  )
}
