import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/lib/db'
import { taskDefinitions } from '@/lib/tasks'
import { downloadText } from '@/lib/download'
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from './ui/accordion'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from './ui/card'
import { Badge } from './ui/badge'
import { Button } from './ui/button'

export function RequestHistory({ archiveId }: { archiveId: string }) {
  const records =
    useLiveQuery(
      () =>
        db.requests
          .filter((r) => r.archiveId === archiveId || r.kind === 'capability')
          .sortBy('createdAt'),
      [archiveId],
    ) ?? []
  const [shown, setShown] = useState(20)
  const latest = [...records].reverse()
  return (
    <Accordion type="single" collapsible>
      <AccordionItem value="requests">
        <AccordionTrigger>请求记录（{records.length}）</AccordionTrigger>
        <AccordionContent>
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              保存渠道、生成结果、用量和错误信息。记录中的请求内容可导出用于排查和重放。
            </p>
            <Button
              variant="outline"
              disabled={!records.length}
              onClick={() =>
                downloadText(
                  'yanju-requests.json',
                  JSON.stringify(records, null, 2),
                  'application/json',
                )
              }
            >
              导出请求记录 JSON
            </Button>
            {latest.slice(0, shown).map((record) => (
              <Card size="sm" key={record.id}>
                <CardHeader>
                  <CardTitle className="flex flex-wrap justify-between gap-2">
                    {taskDefinitions[record.kind].label}
                    {record.attempt ? ' · 纠正' : ''}
                    <Badge variant="outline">
                      {
                        {
                          complete: '成功',
                          partial: '生成中',
                          failed: '失败',
                          cancelled: '已停止',
                        }[record.status]
                      }
                    </Badge>
                  </CardTitle>
                  <CardDescription>
                    {record.channel.name} · {record.channel.model} ·{' '}
                    {new Date(record.createdAt).toLocaleString('zh-CN')}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  <p className="text-sm">
                    估算输入 {record.estimatedInput.toLocaleString()} · 输出上限{' '}
                    {record.request.maxOutputTokens.toLocaleString()} tokens
                  </p>
                  {record.usage && (
                    <p className="text-sm">
                      实际输入 {record.usage.input.toLocaleString()} · 输出{' '}
                      {record.usage.output.toLocaleString()} tokens
                    </p>
                  )}
                  {record.error && <p className="text-sm text-destructive">{record.error}</p>}
                </CardContent>
              </Card>
            ))}
            {latest.length > shown && (
              <Button variant="outline" onClick={() => setShown((n) => n + 20)}>
                展开更早的请求
              </Button>
            )}
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  )
}
