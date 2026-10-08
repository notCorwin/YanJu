import type { TaskInput, AuxiliaryKind } from '../src/lib/tasks'
import type { NarrativeReply } from '../src/lib/schemas'
import { emptyEffects } from '../src/lib/domain-schema'
export function auxiliaryFixture(kind: AuxiliaryKind, input: TaskInput): unknown {
  const history = input.context.history as {
    id: string
    text: string
    blocks: { id: string; text: string }[]
  }[]
  switch (kind) {
    case 'phoneReply':
      return {
        contactRef: input.targetId,
        speaker: '沈渡',
        time: '15:00',
        text: '明天的安排已经确认，我会准备好资料。',
      }
    case 'forumReply':
      return {
        postId: (input.context.forum as { id: string }).id,
        replyTo: input.targetId,
        author: '图书管理员',
        time: '15:00',
        content: '可以先从散文集开始，欢迎继续分享阅读感受。',
      }
    case 'search':
      return {
        entityRefs: ['character-yanju'],
        terms: ['阅读'],
        fromDate: null,
        toDate: null,
        category: 'all',
      }
    case 'persona':
      return {
        name: '林晚',
        gender: '女',
        identity: '修复古籍的研究者',
        prefer: '喜欢阅读与茶',
        force: '不允许代替用户说话、行动或做决定。',
      }
    case 'archiveMetadata':
      return {
        name: '书房里的午后',
        summary: '两人在书房阅读，准备明天的安排。',
        keywords: ['书房', '阅读'],
      }
    case 'continuation':
      return {
        options: ['一起整理书页', '去茶馆见面', '询问明天安排'].map((title, i) => ({
          id: `choice-${i}`,
          title,
          action: `我选择${title}。`,
          scene: '延续书房的阅读话题。',
        })),
      }
    case 'rewrite': {
      const replacement = structuredClone(input.context.target as NarrativeReply)
      replacement.blocks[0].text = replacement.blocks[0].text.replace('午后', '傍晚')
      replacement.effects.states[0].value = '更加平静'
      return { replacement, changedBlockIds: ['b1'] }
    }
    case 'consistency': {
      const entry = history.find((m) => m.blocks.length)
      return {
        summary: '需要确认场景中的时间表述。',
        issues: entry
          ? [
              {
                type: 'time',
                severity: 'warning',
                source: { messageId: entry.id, blockId: entry.blocks[0].id },
                evidence: entry.blocks[0].text.slice(0, 20),
                suggestion: '确认午后时间与当前日期一致。',
              },
            ]
          : [],
      }
    }
    case 'contentImport': {
      const effects = emptyEffects()
      effects.entities = [
        {
          ref: 'new:librarian',
          kind: 'character',
          name: '陆明',
          description: '图书管理员，喜欢整理散文集。',
          sourceBlockId: null,
        },
      ]
      effects.relationships = [
        {
          ref: 'new:colleague',
          from: 'new:librarian',
          to: 'character-yanju',
          type: '同事',
          description: '一起整理藏书',
          sourceBlockId: null,
        },
      ]
      effects.memories = [
        {
          ref: 'new:preference',
          kind: 'preference',
          content: '陆明喜欢散文集',
          entityRefs: ['new:librarian'],
          status: 'active',
          sourceBlockId: null,
        },
      ]
      return {
        title: '图书管理员资料',
        summary: '提取了人物、关系和偏好。',
        effects,
        unrecognized: ['未提供确切出生日期'],
      }
    }
    case 'chapters':
      return {
        title: '阅读篇章',
        chapters: [
          {
            title: '午后的相遇',
            summary: '从开场到书房阅读。',
            messageIds: history.map((m) => m.id),
          },
        ],
      }
    case 'media':
      return {
        trackId: 'ximie',
        reason: '适合安静的书房场景。',
        background: '午后书房，暖色窗光映在书页上。',
        voice: [{ blockId: 'b2', speaker: '宴雎', direction: '温和、克制，用上海话低声询问。' }],
      }
    case 'command':
      return /论坛/.test(input.text)
        ? {
            action: 'mode',
            targetId: null,
            mode: 'forum',
            query: null,
            explanation: '切换到论坛模式。',
          }
        : {
            action: 'phone',
            targetId: 'character-shendu',
            mode: null,
            query: null,
            explanation: '打开沈渡的手机会话。',
          }
  }
}
