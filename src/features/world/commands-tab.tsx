import { IconButton, Prose } from '@/components/shared'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import commands from '@/content/commands.json'
import type { Notify } from '@/lib/types'
import { Copy } from 'lucide-react'

export function CommandsTab({
  notify,
  onInsert,
}: {
  notify: Notify
  onInsert: (text: string) => void
}) {
  return (
    <div className="flex flex-col gap-3">
      {commands.map((c, i) => (
        <Card key={i} size="sm">
          <CardHeader>
            <CardTitle>{c.name}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Prose text={c.text} />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  onInsert(c.text)
                }}
              >
                填入聊天
              </Button>
              <IconButton
                label={`复制${c.name}`}
                onClick={() =>
                  void navigator.clipboard.writeText(c.text).then(
                    () => notify('指令已复制。'),
                    () => notify('复制失败，可以使用「填入聊天」。', true),
                  )
                }
              >
                <Copy data-icon="inline-start" />
              </IconButton>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
