import { describe, expect, it } from 'vitest'
import {
  catalogSelection,
  catalogRouteFingerprint,
  fuzzyCatalogModel,
  findCatalogModel,
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
  it('自定义端点跨服务商选模型，只更新模型资料，保留调用配置', () => {
    const source = catalogFixture()
    const catalog = parseModelCatalog({
      azure: {
        ...source.mock,
        id: 'azure',
        npm: '@ai-sdk/azure',
        api: 'https://${AZURE_RESOURCE_NAME}.openai.azure.com/v1',
        env: ['AZURE_RESOURCE_NAME', 'AZURE_API_KEY'],
      },
    })
    const channel = {
      ...channelFixture,
      connectionMode: 'custom' as const,
      providerId: '',
      modelProviderId: 'mock',
      sdk: '@ai-sdk/openai-compatible',
      baseUrl: 'https://gateway.example/v1',
      apiMode: 'chat-completions' as const,
    }
    const next = selectCatalogModel(channel, catalog.azure, catalog.azure.models['test-model'])
    expect(next).toMatchObject({
      connectionMode: 'custom',
      providerId: '',
      modelProviderId: 'azure',
      sdk: channel.sdk,
      baseUrl: channel.baseUrl,
      apiMode: channel.apiMode,
      contextWindow: 131072,
    })
    expect(catalogSelection(next, catalog)).toMatchObject({ sdk: channel.sdk, api: undefined })
    const fingerprint = catalogRouteFingerprint(next, catalog)
    catalog.azure.npm = '@ai-sdk/google-vertex'
    catalog.azure.api = 'https://unrelated.example'
    catalog.azure.env = ['GOOGLE_VERTEX_PROJECT']
    catalog.azure.models['test-model'].provider = { shape: 'responses', npm: '@ai-sdk/openai' }
    expect(catalogRouteFingerprint(next, catalog)).toBe(fingerprint)
    catalog.azure.models['test-model'].limit.context = 262144
    expect(catalogRouteFingerprint(next, catalog)).not.toBe(fingerprint)
  })

  it('预置模型默认自动探测端点，包括目录中的 completions shape', () => {
    const provider = parseModelCatalog(catalogFixture()).mock
    const model = { ...provider.models['test-model'], provider: { shape: 'completions' } }
    expect(selectCatalogModel(channelFixture, provider, model).apiMode).toBe('auto')
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
      apiMode: 'auto',
      contextWindow: 1000000,
      inputLimit: 900000,
      temperature: null,
      temperatureSupported: false,
    })
    expect(next.maxOutputTokens).toBe(100000)
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
    ).toBe('auto')
    expect(
      selectCatalogModel(
        channelFixture,
        { ...provider, npm: 'ai-gateway-provider' },
        { ...model, provider: { npm: '@ai-sdk/openai', shape: 'responses' } },
      ).apiMode,
    ).toBe('auto')
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
  it('手动模型 ID 使用高置信度模糊匹配，未匹配时保留手填容量', () => {
    const catalog = parseModelCatalog(catalogFixture())
    expect(fuzzyCatalogModel(catalog.mock, 'test-model-x')?.id).toBe('test-model')
    const similar = catalogSelection(
      { ...channelFixture, manualModelId: true, model: 'test-model-x' },
      catalog,
    )
    expect(similar.model.limit.context).toBe(131072)
    const custom = catalogSelection(
      {
        ...channelFixture,
        manualModelId: true,
        model: 'private-model-2026',
        contextWindow: 65536,
        inputLimit: 60000,
        maxOutputTokens: 4096,
      },
      catalog,
    )
    expect(custom.model.limit).toEqual({ context: 65536, input: 60000, output: 4096 })
  })

  it('自定义 Model ID 在整个目录查找精确或相近资料，保留手动容量覆盖', () => {
    const source = catalogFixture()
    const catalog = parseModelCatalog({
      ...source,
      other: {
        ...source.mock,
        id: 'other',
        models: {
          flagship: { ...source.mock.models['test-model'], id: 'flagship', name: 'Flagship' },
        },
      },
    })
    expect(findCatalogModel(catalog, 'flagship', 'mock')?.provider.id).toBe('other')
    expect(findCatalogModel(catalog, 'flagship-v2', 'mock')).toBeUndefined()
    expect(findCatalogModel(catalog, 'test-model-x', 'other')?.model.id).toBe('test-model')
    const selected = selectCatalogModel(
      {
        ...channelFixture,
        contextWindowOverride: true,
        maxOutputTokensOverride: true,
        contextWindow: 50000,
        maxOutputTokens: 3000,
      },
      catalog.mock,
      catalog.mock.models['second-model'],
    )
    expect(selected).toMatchObject({
      contextWindow: 50000,
      maxOutputTokens: 3000,
      contextWindowOverride: true,
      maxOutputTokensOverride: true,
    })
  })

  it('不支持温度的模型默认省略参数，但仍允许用户覆盖并在切换模型后保留', () => {
    const provider = parseModelCatalog(catalogFixture()).mock
    const model = { ...provider.models['test-model'], temperature: false }
    expect(selectCatalogModel(channelFixture, provider, model).temperature).toBeNull()
    expect(
      selectCatalogModel(
        { ...channelFixture, temperature: 0.6, temperatureOverride: true },
        provider,
        model,
      ),
    ).toMatchObject({ temperature: 0.6, temperatureOverride: true })
  })
})
