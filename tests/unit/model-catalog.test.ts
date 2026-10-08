import { describe, expect, it } from 'vitest'
import {
  catalogSelection,
  parseModelCatalog,
  selectCatalogModel,
} from '../../src/lib/model-catalog'
import { catalogFixture } from '../model-catalog-fixture'
import { channelFixture } from '../fixtures'

describe('Models.dev Provider 与模型目录', () => {
  it('Models.dev 的 completions shape 固定使用 Chat Completions', () => {
    const provider = parseModelCatalog(catalogFixture()).mock
    const model = { ...provider.models['test-model'], provider: { shape: 'completions' } }
    expect(selectCatalogModel(channelFixture, provider, model).apiMode).toBe('chat-completions')
  })
  it('只保留在该 Provider 上明确支持 Structured Outputs 的文本模型', () => {
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
    expect(Object.keys(catalog)).toEqual(['mock', 'mixed'])
    expect(Object.keys(catalog.mixed.models)).toEqual(['test-model'])
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
  it('原生 SDK 的 Responses 覆盖保持 SDK 认证路由，Cloudflare 也不会绕过 Gateway', () => {
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
    ).toBe('native')
  })

  it('拒绝不存在的 Provider 或模型，并拒绝空目录', () => {
    expect(() =>
      catalogSelection(
        { ...channelFixture, model: 'custom-model' },
        parseModelCatalog(catalogFixture()),
      ),
    ).toThrow('Models.dev')
    expect(() => parseModelCatalog({})).toThrow('Structured Outputs')
  })
})
