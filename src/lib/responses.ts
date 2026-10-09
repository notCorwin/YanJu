import { APICallError, type LanguageModelMiddleware } from 'ai'

type StreamCall = Parameters<NonNullable<LanguageModelMiddleware['wrapStream']>>[0]
type StreamResult = Awaited<ReturnType<StreamCall['doStream']>>
type ModelStreamPart = StreamResult['stream'] extends ReadableStream<infer Part> ? Part : never

export class ResponseLifecycleError extends Error {
  constructor(
    public kind: 'truncated' | 'refusal' | 'failed' | 'interrupted',
    detail?: string,
  ) {
    const messages = {
      truncated: 'truncated: token limit；回复达到模型自身容量，已保留收到的内容。',
      refusal: '模型拒绝了本次生成，已保留收到的内容。',
      failed: 'Responses 服务端生成失败，已保留收到的内容。请重试或重新测试渠道。',
      interrupted:
        'Responses 连接中断或未返回完整终止事件，已保留收到的内容。请重试或重新测试渠道。',
    }
    super(`${messages[kind]}${detail ? ` ${detail}` : ''}`)
    this.name = 'ResponseLifecycleError'
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return record(JSON.parse(value))
    } catch {
      return {}
    }
  }
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function refusal(value: unknown): string | undefined {
  const item = record(value)
  if (item.type === 'refusal') return String(item.refusal ?? '模型未返回结构化内容。')
  for (const key of ['output', 'content']) {
    if (Array.isArray(item[key])) {
      for (const child of item[key]) {
        const detail = refusal(child)
        if (detail !== undefined) return detail
      }
    }
  }
}

function checkResponse(value: unknown, requireCompleted = false) {
  const response = record(value)
  const rejected = refusal(response)
  if (rejected !== undefined) throw new ResponseLifecycleError('refusal', rejected)
  const reason = record(response.incomplete_details).reason
  if (response.status === 'incomplete' || reason != null) {
    throw new ResponseLifecycleError(
      reason === 'max_output_tokens'
        ? 'truncated'
        : reason === 'content_filter'
          ? 'refusal'
          : 'failed',
      typeof reason === 'string' ? reason : undefined,
    )
  }
  if (response.error || response.status === 'failed' || response.status === 'cancelled') {
    throw new ResponseLifecycleError(
      'failed',
      String(record(response.error).message ?? response.status),
    )
  }
  if (requireCompleted && response.status !== 'completed')
    throw new ResponseLifecycleError('interrupted')
}

/** The SDK owns JSON/SSE parsing; this guard prevents invalid terminal states becoming corrections. */
export const responsesLifecycle: LanguageModelMiddleware = {
  transformParams: async ({ params }) => ({ ...params, includeRawChunks: true }),
  wrapGenerate: async ({ doGenerate }) => {
    try {
      const result = await doGenerate()
      checkResponse(result.response?.body, true)
      return result
    } catch (error) {
      if (APICallError.isInstance(error) && error.responseBody) {
        const body = record(error.responseBody)
        // HTTP request errors (including unsupported formats) are not response lifecycle events.
        if (body.object === 'response' || typeof body.status === 'string') checkResponse(body)
      }
      throw error
    }
  },
  wrapStream: async ({ doStream, params }) => {
    const result = await doStream()
    let completed = false
    const guarded = result.stream.pipeThrough(
      new TransformStream<ModelStreamPart, ModelStreamPart>({
        transform(chunk, controller) {
          if (chunk.type === 'raw') {
            const frame = record(chunk.rawValue)
            if (frame.type === 'response.completed') {
              checkResponse(frame.response, true)
              completed = true
            } else if (frame.type === 'response.incomplete') {
              checkResponse({ ...record(frame.response), status: 'incomplete' })
            } else if (frame.type === 'response.failed' || frame.type === 'error') {
              const response =
                frame.type === 'error' ? { error: frame.error ?? frame } : frame.response
              checkResponse({ ...record(response), status: 'failed' })
            } else if (
              frame.type === 'response.refusal.delta' ||
              frame.type === 'response.refusal.done'
            ) {
              throw new ResponseLifecycleError(
                'refusal',
                String(frame.refusal ?? frame.delta ?? ''),
              )
            } else if (
              frame.type === 'response.output_item.added' ||
              frame.type === 'response.output_item.done'
            ) {
              const detail = refusal(frame.item)
              if (detail !== undefined) throw new ResponseLifecycleError('refusal', detail)
            }
          }
          if (chunk.type === 'finish' && !completed && !params.abortSignal?.aborted)
            throw new ResponseLifecycleError('interrupted')
          controller.enqueue(chunk)
        },
        flush() {
          if (!completed && !params.abortSignal?.aborted)
            throw new ResponseLifecycleError('interrupted')
        },
      }),
    )
    const reader = guarded.getReader()
    return {
      ...result,
      stream: new ReadableStream<ModelStreamPart>({
        async pull(controller) {
          try {
            const chunk = await reader.read()
            if (chunk.done) {
              reader.releaseLock()
              controller.close()
            } else controller.enqueue(chunk.value)
          } catch (error) {
            reader.releaseLock()
            controller.error(
              params.abortSignal?.aborted || error instanceof ResponseLifecycleError
                ? error
                : new ResponseLifecycleError(
                    'interrupted',
                    error instanceof Error ? error.message : String(error),
                  ),
            )
          }
        },
        cancel(reason) {
          return reader.cancel(reason).finally(() => reader.releaseLock())
        },
      }),
    }
  },
}
