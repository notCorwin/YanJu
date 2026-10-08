import { describe, it, expect } from 'vitest'
import {
  sanitizePartial,
  validateNarrative,
  validateForum,
  validateCompression,
} from '../../src/lib/schemas'
import { narrativeFixture, forumFixture, compressionFixture } from '../fixtures'

describe('严格内容协议', () => {
  it('异常部分字段不会进入渲染，合法部分内容仍保留', () => {
    const partial = sanitizePartial('narrative', {
      scene: { time: 123, location: '书房', characters: '非法数组' },
      blocks: [{ kind: 'narration', text: '已收到的文字', translation: '' }],
      phone: { memos: '非法数组' },
      diary: { text: { invalid: true } },
    })
    expect(partial.scene?.time).toBeUndefined()
    expect(partial.scene?.location).toBe('书房')
    expect(partial.scene?.characters).toBeUndefined()
    expect(partial.blocks?.[0]?.text).toBe('已收到的文字')
    expect(partial.phone?.memos).toBeUndefined()
    expect(partial.diary?.text).toBeUndefined()
  })
  it('完整回复满足各核心模块', () =>
    expect(validateNarrative(narrativeFixture)).toEqual(narrativeFixture))
  it('拒绝缺失核心模块和多余界面字段', () => {
    const { phone: _phone, ...missing } = narrativeFixture
    expect(_phone.memos).toHaveLength(5)
    expect(() => validateNarrative(missing)).toThrow(/phone/)
    expect(() => validateNarrative({ ...narrativeFixture, css: 'custom' })).toThrow()
  })
  it('空内容、短正文、缺翻译、手机数量和日记字数均校验', () => {
    expect(() =>
      validateNarrative({
        ...narrativeFixture,
        state: { ...narrativeFixture.state, desire: '  ' },
      }),
    ).toThrow(/不能为空/)
    expect(() =>
      validateNarrative({
        ...narrativeFixture,
        blocks: [
          {
            id: 'b1',
            speakerRef: 'character-yanju',
            kind: 'dialogue',
            text: '一句话',
            translation: '',
          },
        ],
      }),
    ).toThrow(/750|翻译/)
    expect(() =>
      validateNarrative({
        ...narrativeFixture,
        phone: { ...narrativeFixture.phone, memos: ['短'] },
      }),
    ).toThrow(/备忘录/)
    expect(() =>
      validateNarrative({
        ...narrativeFixture,
        diary: { ...narrativeFixture.diary, text: '短日记' },
      }),
    ).toThrow(/300/)
  })
  it('论坛必须恰好有 50 条非空、唯一 ID 的回答', () => {
    expect(validateForum(forumFixture).answers).toHaveLength(50)
    expect(() =>
      validateForum({ ...forumFixture, answers: forumFixture.answers.slice(1) }),
    ).toThrow(/50/)
    expect(() =>
      validateForum({
        ...forumFixture,
        answers: forumFixture.answers.map((a) => ({ ...a, id: 'same' })),
      }),
    ).toThrow(/ID/)
  })
  it('摘要不允许生成角色模块', () => {
    expect(validateCompression(compressionFixture)).toEqual(compressionFixture)
    expect(() => validateCompression({ ...compressionFixture, phone: {} })).toThrow()
  })
})
