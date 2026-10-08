import type { NarrativeReply, ForumReply, CompressionResult } from '../src/lib/schemas'
import { defaults, type Channel, type SaveFile, type StoredMessage } from '../src/lib/types'

const sentence = '午后书房的窗边很安静，他把今天要读的书放好，又记下明天的安排。'
export const narrativeFixture: NarrativeReply = {
  scene: {
    time: '2019年6月1日 14:00',
    location: '书房',
    characters: ['宴雎', '沈辞玉'],
    quoteZh: '窗外的光静静经过书页，让此刻的相遇留下温暖的回响与明天仍然可以继续的故事。',
    quoteEn: 'The quiet afternoon holds our words gently until the light returns again.',
    source: '测试用书',
  },
  blocks: [
    { kind: 'narration', text: sentence.repeat(35), translation: '' },
    { kind: 'dialogue', text: '侬要看哪一本呀。', translation: '你想看哪一本呀。' },
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
      reason: '为了迎接明天的凉风挑选了柔软材质与适合日常穿着的浅色款式',
    })),
    conversations: Array.from({ length: 3 }, (_, i) => ({
      contact: `联系人${i + 1}`,
      messages: Array.from({ length: 4 }, (_, j) => ({
        speaker: j % 2 ? '宴雎' : `联系人${i + 1}`,
        time: '14:00',
        text: '明天的安排已经确认。',
      })),
    })),
  },
  diary: { text: sentence.repeat(14), countdownDays: 60, explanation: '希望那天也有这样的阳光。' },
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
  baseUrl: 'https://mock.example/v1',
  apiKey: 'test-key-not-real',
  model: 'test-model',
  temperature: 0.9,
  maxOutputTokens: 4096,
  contextWindow: 131072,
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

// A valid, lossless 1x1 PNG used for byte-level background round trips.
export const pngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
export const pngDataUrl = `data:image/png;base64,${pngBase64}`
export const saveFixture: SaveFile = {
  version: 2,
  exportedAt: '2026-10-08T00:00:00Z',
  archives: [
    { id: 'archive-1', name: '阅读篇章', createdAt: 1, updatedAt: 2, revision: 0, draft: '' },
    { id: 'archive-2', name: '第二篇章', createdAt: 1, updatedAt: 1, revision: 0, draft: '' },
  ],
  messages: [
    {
      ...messageFixture('opening', 'assistant', '午后的书房很安静，今天想读哪一本书？', 0),
      kind: 'legacy',
      legacy: { body: '午后的书房很安静，今天想读哪一本书？', panels: [] },
    },
    {
      ...messageFixture('opening-2', 'assistant', '第二篇章的开场。', 0),
      archiveId: 'archive-2',
      kind: 'legacy',
      legacy: { body: '第二篇章的开场。', panels: [] },
    },
  ],
  channels: [
    channelFixture,
    { ...channelFixture, id: 'channel-2', name: '第二渠道', model: 'second-model' },
  ],
  masks: [
    {
      id: 'persona-1',
      name: '测试读者',
      gender: '其他',
      identity: '读者',
      prefer: '阅读',
      force: '不允许代替我说话。',
      createdAt: 1,
    },
  ],
  settings: {
    ...defaults,
    activeArchiveId: 'archive-1',
    activeChannelId: 'channel-1',
    activePersonaId: 'persona-1',
  },
}
