import { describe, expect, it, vi } from 'vitest'
import { createBrowserFetch } from '../../src/lib/browser-fetch'

describe('浏览器 Provider 请求', () => {
  it.each<HeadersInit>([
    {
      'User-Agent': 'ai-sdk/test',
      Authorization: 'Bearer test-key',
      'Content-Type': 'application/json',
    },
    [
      ['user-AGENT', 'ai-sdk/test'],
      ['Authorization', 'Bearer test-key'],
      ['Content-Type', 'application/json'],
    ],
    new Headers({
      'user-agent': 'ai-sdk/test',
      Authorization: 'Bearer test-key',
      'Content-Type': 'application/json',
    }),
  ])('移除 SDK User-Agent，保留认证、正文、取消信号及原始请求头 (%#)', async (headers) => {
    const signal = new AbortController().signal
    const result = new Response('data: streaming\n\n')
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(result)
    const init = { method: 'POST', headers, body: '{"test":true}', signal }
    expect(await createBrowserFetch(fetcher)('https://provider.example/v1', init)).toBe(result)
    const sent = fetcher.mock.calls[0][1]!
    expect(sent).toMatchObject({ method: 'POST', body: init.body, signal })
    expect(Object.fromEntries(new Headers(sent.headers))).toEqual({
      authorization: 'Bearer test-key',
      'content-type': 'application/json',
    })
    expect(new Headers(headers).get('user-agent')).toBe('ai-sdk/test')
  })

  it('继承 Request 的认证和正文，保留流式响应且不提前读取', async () => {
    const request = new Request('https://provider.example/v1', {
      method: 'POST',
      headers: { 'User-Agent': 'ai-sdk/test', 'X-API-Key': 'test-key' },
      body: '{"test":true}',
    })
    const result = new Response(new ReadableStream())
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(result)
    expect(await createBrowserFetch(fetcher)(request)).toBe(result)
    expect(fetcher.mock.calls[0][0]).toBe(request)
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('x-api-key')).toBe('test-key')
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).has('user-agent')).toBe(false)
    expect(request.headers.get('user-agent')).toBe('ai-sdk/test')
    expect(request.bodyUsed).toBe(false)
    expect(result.body?.locked).toBe(false)
  })

  it('显式 init 请求头按照 Fetch 语义覆盖 Request 请求头', async () => {
    const request = new Request('https://provider.example/v1', {
      headers: { Authorization: 'Bearer replaced-key', 'User-Agent': 'ai-sdk/test' },
    })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response())
    await createBrowserFetch(fetcher)(request, { headers: { 'X-API-Key': 'current-key' } })
    expect(Object.fromEntries(new Headers(fetcher.mock.calls[0][1]?.headers))).toEqual({
      'x-api-key': 'current-key',
    })
  })

  it('使用原生 Fetch 的默认入口也处理 SDK 请求头', async () => {
    const original = globalThis.fetch
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response())
    globalThis.fetch = fetcher
    try {
      await createBrowserFetch()('https://provider.example/v1', {
        headers: {
          'User-Agent': 'ai-sdk/test',
          'ai-language-model-id': 'deepseek/deepseek-v4.1-flash',
        },
      })
      expect(Object.fromEntries(new Headers(fetcher.mock.calls[0][1]?.headers))).toEqual({
        'ai-language-model-id': 'deepseek/deepseek-v4.1-flash',
      })
    } finally {
      globalThis.fetch = original
    }
  })

  it('网络失败和取消保持原始错误，不重复请求', async () => {
    const error = new DOMException('已取消', 'AbortError')
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(error)
    await expect(createBrowserFetch(fetcher)('https://provider.example/v1')).rejects.toBe(error)
    expect(fetcher).toHaveBeenCalledOnce()
  })
})
