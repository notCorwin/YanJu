import { completion, response, responseSse, sse } from './fixtures'
import type { ApiProtocol } from '../src/lib/types'

export const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
export function protocolResponse(protocol: ApiProtocol, value: unknown, streaming: boolean) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const anthropic = {
    id: 'mock',
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 30 },
  }
  const google = {
    candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 30, totalTokenCount: 40 },
  }
  const interaction = {
    id: 'mock-interaction',
    status: 'completed',
    model: 'test-model',
    steps: [{ type: 'model_output', content: [{ type: 'text', text }] }],
    usage: { total_input_tokens: 10, total_output_tokens: 30, total_tokens: 40 },
  }
  let body: unknown
  let stream: string
  if (protocol === 'messages') {
    body = anthropic
    stream = [
      {
        type: 'message_start',
        message: {
          ...anthropic,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 30 },
      },
      { type: 'message_stop' },
    ]
      .map(event)
      .join('')
  } else if (protocol === 'generate-content') {
    body = google
    stream = event(google)
  } else if (protocol === 'interactions') {
    body = interaction
    stream = [
      {
        event_type: 'interaction.created',
        interaction: { id: 'mock-interaction', status: 'in_progress' },
      },
      { event_type: 'step.start', index: 0, step: { type: 'model_output', content: [] } },
      { event_type: 'step.delta', index: 0, delta: { type: 'text', text } },
      { event_type: 'step.stop', index: 0 },
      { event_type: 'interaction.completed', interaction },
    ]
      .map(event)
      .join('')
  } else if (protocol === 'responses') {
    body = response(value)
    stream = responseSse(value).join('')
  } else if (protocol === 'completions') {
    body = {
      ...completion(value),
      object: 'text_completion',
      choices: [{ index: 0, text, finish_reason: 'stop', logprobs: null }],
    }
    stream =
      event({
        ...(body as object),
        choices: [{ index: 0, text, finish_reason: null, logprobs: null }],
      }) +
      event({
        ...(body as object),
        choices: [{ index: 0, text: '', finish_reason: 'stop', logprobs: null }],
      }) +
      'data: [DONE]\n\n'
  } else {
    body =
      typeof value === 'string'
        ? {
            ...completion({}),
            choices: [
              { index: 0, message: { role: 'assistant', content: value }, finish_reason: 'stop' },
            ],
          }
        : completion(value)
    stream =
      typeof value === 'string'
        ? event({
            ...completion({}),
            choices: [
              { index: 0, delta: { role: 'assistant', content: value }, finish_reason: 'stop' },
            ],
          }) + 'data: [DONE]\n\n'
        : sse(value).join('')
  }
  return {
    body: streaming ? stream : JSON.stringify(body),
    contentType: streaming ? 'text/event-stream' : 'application/json',
  }
}
