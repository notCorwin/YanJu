import { describe, expect, it } from 'vitest'
import {
  catalogSelection,
  parseModelCatalog,
  selectCatalogModel,
} from '../../src/lib/model-catalog'
import { catalogFixture } from '../model-catalog-fixture'
import { channelFixture } from '../fixtures'

describe('Models.dev Provider 与模型目录', () => {
  it('选择和切换模型保留用户自定义的渠道名称', () => {
    const provider = parseModelCatalog(catalogFixture()).mock
    expect(
      selectCatalogModel(
        { ...channelFixture, name: '长篇创作' },
        provider,
        provider.models['test-model'],
      ).name,
    ).toBe('长篇创作')
  })
  it('Models.dev 的 completions shape 固定使用 Chat Completions', () => {
    const provider = parseModelCatalog(catalogFixture()).mock
    const model = { ...provider.models['test-model'], provider: { shape: 'completions' } }
    expect(selectCatalogModel(channelFixture, provider, model).apiMode).toBe('chat-completions')
  })
  it('保留所有文本模型，包括没有 Structured Outputs 标记的模型', () => {
    const source = catalogFixture()
    const model = source.mock.models['test-model']
    const catalog = parseModelCatalog({
      ...source,
      invalid: { id: 'invalid' },
      empty: {
        ...source.mock,
        id: 'empty',
        models: { absent: { ...model, structured_output: undefined } },
      },
      mixed: {
        ...source.mock,
        id: 'mixed',
        models: {
          valid: model,
          false: { ...model, id: 'false', structured_output: false },
          image: { ...model, id: 'image', modalities: { input: ['text'], output: ['image'] } },
          unknown: { ...model, id: 'unknown', limit: { context: 0 } },
        },
      },
    })
    expect(Object.keys(catalog)).toEqual(['mock', 'empty', 'mixed'])
    expect(Object.keys(catalog.mixed.models)).toEqual(['test-model', 'false'])
  })
  it('模型级 SDK、API、协议和容量覆盖项优先于 Provider 默认值', () => {
    const source = catalogFixture()
    const model = {
      ...source.mock.models['test-model'],
      temperature: false,
      limit: { context: 1000000, input: 900000, output: 100000 },
      provider: { npm: '@ai-sdk/openai', api: 'https://official.example/v1', shape: 'responses' },
    }
    const catalog = parseModelCatalog({
      mock: { ...source.mock, npm: '@ai-sdk/cohere', models: { model } },
    })
    const next = selectCatalogModel(channelFixture, catalog.mock, catalog.mock.models['test-model'])
    expect(next).toMatchObject({
      sdk: '@ai-sdk/openai',
      apiMode: 'responses',
      contextWindow: 1000000,
      inputLimit: 900000,
      temperature: null,
      temperatureSupported: false,
    })
    expect(next).not.toHaveProperty('maxOutputTokens')
    expect(catalogSelection(next, catalog)).toMatchObject({
      sdk: '@ai-sdk/openai',
      api: 'https://official.example/v1',
    })
    expect(next.capability).toBeUndefined()
  })
  it('原生 SDK 保持认证路由，社区 SDK 统一映射到官方兼容实现', () => {
    const source = catalogFixture()
    const model = {
      ...source.mock.models['test-model'],
      provider: { npm: '@ai-sdk/amazon-bedrock/mantle', shape: 'responses' },
    }
    const provider = parseModelCatalog({
      mock: { ...source.mock, npm: '@ai-sdk/amazon-bedrock', models: { model } },
    }).mock
    expect(
      selectCatalogModel(channelFixture, provider, provider.models['test-model']).apiMode,
    ).toBe('native')
    expect(
      selectCatalogModel(
        channelFixture,
        { ...provider, npm: 'ai-gateway-provider' },
        { ...model, provider: { npm: '@ai-sdk/openai', shape: 'responses' } },
      ).apiMode,
    ).toBe('responses')
  })

  it('拒绝不存在的 Provider 或模型，并拒绝空目录', () => {
    expect(() =>
      catalogSelection(
        { ...channelFixture, model: 'custom-model' },
        parseModelCatalog(catalogFixture()),
      ),
    ).toThrow('Models.dev')
    expect(() => parseModelCatalog({})).toThrow('文本模型')
  })
})
