import type { RequestDiagnostics } from '@/lib/types'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion'

export function RequestDetails({ value }: { value?: RequestDiagnostics }) {
  if (!value) return null
  const time = (ms: number) =>
    `${(ms / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 秒`
  return (
    <Accordion type="single" collapsible>
      <AccordionItem value="request">
        <AccordionTrigger>生成详情</AccordionTrigger>
        <AccordionContent>
          <dl className="grid grid-cols-2 gap-2 wrap-break-word text-xs text-muted-foreground">
            <dt>模型</dt>
            <dd>{value.model}</dd>
            <dt>回复协议</dt>
            <dd>{value.schema}</dd>
            <dt>首个内容</dt>
            <dd>{value.firstTokenMs === undefined ? '尚未返回' : time(value.firstTokenMs)}</dd>
            <dt>总耗时</dt>
            <dd>{time(value.elapsedMs)}</dd>
            <dt>校验纠正</dt>
            <dd>{value.corrections} 次</dd>
            {value.httpStatus && (
              <>
                <dt>HTTP 状态</dt>
                <dd>{value.httpStatus}</dd>
              </>
            )}
            {value.requestId && (
              <>
                <dt>渠道请求编号</dt>
                <dd>{value.requestId}</dd>
              </>
            )}
            {value.finishReason && (
              <>
                <dt>结束原因</dt>
                <dd>{value.finishReason}</dd>
              </>
            )}
          </dl>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  )
}
