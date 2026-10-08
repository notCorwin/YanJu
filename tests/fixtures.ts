import type { NarrativeReply, ForumReply, CompressionResult } from '../src/lib/schemas'
import { emptyEffects } from '../src/lib/domain-schema'
import type { Channel, StoredMessage } from '../src/lib/types'

const sentence = '午后书房的窗边很安静，他把今天要读的书放好，又记下明天的安排。'
export const narrativeFixture: NarrativeReply = {
  scene: {
    time: '2019年6月1日 14:00',
    location: '书房',
    characters: ['宴雎', '沈辞玉'],
    quoteZh: '窗外的光静静经过书页，让此刻的相遇留下温暖的回响与明天仍然可以继续的故事。',
    quoteEn: 'The quiet afternoon holds our words gently until the light returns again.',
    source: '测试用书',
    locationRef: 'new:study',
    characterRefs: ['character-yanju', 'character-user'],
  },
  blocks: [
    { id: 'b1', speakerRef: null, kind: 'narration', text: sentence.repeat(35), translation: '' },
    {
      id: 'b2',
      speakerRef: 'character-yanju',
      kind: 'dialogue',
      text: '侬要看哪一本呀。',
      translation: '你想看哪一本呀。',
    },
  ],
  state: {
    innerVoice: sentence.repeat(5),
    desire: '想一起把书读完。',
    wishes: ['把书递过去', '听你说说想法', '记住今天的光线'],
    spokenLine: '侬要看哪一本呀。',
    subtext: '希望你能自由选择。',
  },
  phone: {
    memos: Array.from(
      { length: 5 },
      (_, i) => `明天第${i + 1}项安排是在书房整理今天的笔记和资料，并确认下周会面时间`,
    ),
    recommendations: Array.from({ length: 5 }, (_, i) => ({
      brand: `品牌${i + 1}`,
      item: '新的羊毛围巾',
      reaction: '这个颜色很合适。',
    })),
    purchases: Array.from({ length: 5 }, () => ({
      item: '羊毛围巾',
      price: '两千元',
      amountMinor: 200000,
      currency: 'CNY',
      reason: '为了迎接明天的凉风挑选了柔软材质与适合日常穿着的浅色款式',
    })),
    conversations: Array.from({ length: 3 }, (_, i) => ({
      contact: `联系人${i + 1}`,
      contactRef: ['character-shendu', 'character-father', 'character-mother'][i],
      messages: Array.from({ length: 4 }, (_, j) => ({
        speaker: j % 2 ? '宴雎' : `联系人${i + 1}`,
        time: '14:00',
        text: '明天的安排已经确认。',
      })),
    })),
  },
  diary: { text: sentence.repeat(14), countdownDays: 60, explanation: '希望那天也有这样的阳光。' },
  effects: {
    ...emptyEffects(),
    entities: [
      {
        ref: 'new:study',
        kind: 'location',
        name: '书房',
        description: '庄园书房',
        sourceBlockId: 'b1',
      },
    ],
    states: [
      { entityRef: 'character-yanju', key: '心情', value: '期待一起阅读', sourceBlockId: 'b1' },
    ],
    events: [
      {
        ref: 'new:reading',
        title: '一起选书',
        time: '2019-06-01',
        locationRef: 'new:study',
        participants: ['character-yanju', 'character-user'],
        description: '在书房讨论阅读',
        sourceBlockId: 'b1',
      },
    ],
    memories: [
      {
        ref: 'new:reading',
        kind: 'fact',
        content: '两人在书房讨论阅读',
        entityRefs: ['character-yanju', 'character-user'],
        status: 'active',
        sourceBlockId: 'b1',
      },
    ],
    goals: [
      {
        ref: 'new:notes',
        ownerRef: 'character-yanju',
        description: '明天整理笔记',
        dueDate: '2019-06-02',
        status: 'open',
        sourceBlockId: 'b1',
      },
    ],
    clock: { dateTime: '2019-06-01T14:00:00+08:00', proposalDate: '2019-07-31' },
  },
}
export const forumFixture: ForumReply = {
  post: {
    id: 'post-1',
    title: '今天该读哪一本书？',
    author: '沈辞玉',
    time: '2019年6月1日',
    content: '想在安静的午后读一本有趣的书。',
    tags: ['阅读'],
    views: 100,
    followers: 50,
  },
  answers: Array.from({ length: 50 }, (_, i) => ({
    id: `answer-${i}`,
    author: `读者${i + 1}`,
    time: '14:00',
    content: `第${i + 1}条建议：可以从书架上选择一本喜欢的散文集。`,
    likes: i,
    replyTo: '',
  })),
}
export const compressionFixture: CompressionResult = {
  summary: '两人在书房讨论阅读与明天的安排。',
  relationships: ['宴雎与沈辞玉相识'],
  timeline: [{ time: '2019年6月1日', location: '书房', event: '选书' }],
  decisions: ['明天整理笔记'],
  unfinished: ['确认会面时间'],
}
export const channelFixture: Channel = {
  id: 'channel-1',
  name: '测试渠道',
  providerId: 'mock',
  sdk: '@ai-sdk/openai',
  temperatureSupported: true,
  baseUrl: 'https://mock.example/v1',
  apiKey: 'test-key-not-real',
  model: 'test-model',
  apiMode: 'chat-completions',
  temperature: 0.9,
  contextWindow: 131072,
  requestTimeoutMs: 300000,
  createdAt: 1,
}
export const messageFixture = (
  id: string,
  role: 'user' | 'assistant',
  content: string,
  sequence: number,
): StoredMessage => ({
  id,
  role,
  content,
  sequence,
  createdAt: sequence + 1,
  archiveId: 'archive-1',
  kind: 'narrative',
  status: 'complete',
})
export function completion(value: unknown, finishReason = 'stop') {
  return {
    id: 'mock-completion',
    object: 'chat.completion',
    created: 1,
    model: 'test-model',
    apiMode: 'chat-completions',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: JSON.stringify(value) },
        finish_reason: finishReason,
      },
    ],
    usage: { prompt_tokens: 12000, completion_tokens: 2048, total_tokens: 14048 },
  }
}
export function sse(value: unknown, finishReason = 'stop', step = 150) {
  const json = JSON.stringify(value)
  const chunks = []
  for (let i = 0; i < json.length; i += step)
    chunks.push(
      `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: { content: json.slice(i, i + step) }, finish_reason: null }] })}\n\n`,
    )
  chunks.push(
    `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 12000, completion_tokens: 2048, total_tokens: 14048 } })}\n\ndata: [DONE]\n\n`,
  )
  return chunks
}

export const capabilityFixture = {
  ready: true,
  echo: 'YanJu strict output',
  probe: {
    mode: 'strict',
    count: 2,
    samples: [
      { label: 'nested', note: null, enabled: true },
      { label: 'array', note: 'ok', enabled: false },
    ],
  },
}

export function response(value: unknown, status = 'completed', reason?: string) {
  return {
    id: 'resp_mock',
    object: 'response',
    created_at: 1,
    model: 'test-model',
    status,
    error: null,
    incomplete_details: reason ? { reason } : null,
    output: [
      {
        type: 'message',
        id: 'msg_mock',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: JSON.stringify(value), annotations: [] }],
      },
    ],
    usage: { input_tokens: 12000, output_tokens: 2048, total_tokens: 14048 },
  }
}

export function responseSse(value: unknown, terminal = 'completed', reason?: string, step = 150) {
  const json = JSON.stringify(value)
  let sequence = 0
  const event = (frame: Record<string, unknown>) =>
    `event: ${frame.type}\ndata: ${JSON.stringify({ ...frame, sequence_number: sequence++ })}\n\n`
  const chunks = [
    event({
      type: 'response.created',
      response: { ...response(value), status: 'in_progress', output: [] },
    }),
    event({
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        type: 'message',
        id: 'msg_mock',
        role: 'assistant',
        status: 'in_progress',
        content: [],
      },
    }),
  ]
  for (let i = 0; i < json.length; i += step)
    chunks.push(
      event({
        type: 'response.output_text.delta',
        item_id: 'msg_mock',
        output_index: 0,
        content_index: 0,
        delta: json.slice(i, i + step),
      }),
    )
  chunks.push(
    event({ type: 'response.output_item.done', output_index: 0, item: response(value).output[0] }),
  )
  if (terminal !== 'missing')
    chunks.push(
      event({ type: `response.${terminal}`, response: response(value, terminal, reason) }),
    )
  return chunks
}
