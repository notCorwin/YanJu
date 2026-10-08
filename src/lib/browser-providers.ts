import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createOpenAI } from '@ai-sdk/openai'
import { APICallError } from 'ai'
import { parseJsonEventStream } from '@ai-sdk/provider-utils'
import { z } from 'zod'

type Options = {
  apiKey?: string
  baseURL?: string
  fetch?: typeof fetch
  credential?: Record<string, unknown>
  resourceGroup?: string
}
const endpoint = (value: string) => value.replace(/\/+$/, '')
const tokenSchema = z.object({ access_token: z.string(), expires_in: z.number().optional() })

async function checkedJson(response: Response, url: string): Promise<unknown> {
  if (!response.ok)
    throw new APICallError({
      message: `Provider 认证或资源查询失败（HTTP ${response.status}）`,
      statusCode: response.status,
      url,
      requestBodyValues: undefined,
      responseHeaders: Object.fromEntries(response.headers),
      responseBody: await response.text(),
      isRetryable: response.status >= 500,
    })
  return response.json()
}

/** QVAC's external HTTP mode; its managed CLI/process mode cannot run in browsers. */
export function createBrowserQvac(options: Options) {
  return createOpenAICompatible({
    name: 'qvac',
    baseURL: options.baseURL ?? 'http://127.0.0.1:11435/v1',
    apiKey: options.apiKey ?? 'qvac',
    fetch: options.fetch,
    supportsStructuredOutputs: true,
    includeUsage: true,
  })
}

/** SAP's Node SDK uses the same orchestration v2 HTTP protocol and OpenAI-shaped final_result. */
export function createBrowserSAP(options: Options) {
  const credential = z
    .object({
      clientid: z.string().min(1),
      clientsecret: z.string().min(1),
      url: z.url(),
      serviceurls: z.object({ AI_API_URL: z.url() }),
    })
    .parse(options.credential)
  const fetcher = options.fetch ?? fetch
  const base = endpoint(credential.serviceurls.AI_API_URL)
  let auth: { token: string; expires: number } | undefined
  let deploymentId: string | undefined
  const headers = async (signal?: AbortSignal | null) => {
    if (!auth || auth.expires <= Date.now()) {
      const url = `${endpoint(credential.url)}/oauth/token`
      const data = tokenSchema.parse(
        await checkedJson(
          await fetcher(url, {
            method: 'POST',
            signal,
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Authorization: `Basic ${btoa(`${credential.clientid}:${credential.clientsecret}`)}`,
            },
            body: new URLSearchParams({ grant_type: 'client_credentials' }),
          }),
          url,
        ),
      )
      auth = {
        token: data.access_token,
        expires: Date.now() + Math.max(0, (data.expires_in ?? 300) - 30) * 1000,
      }
    }
    return {
      Authorization: `Bearer ${auth.token}`,
      'AI-Resource-Group': options.resourceGroup ?? 'default',
      'Content-Type': 'application/json',
    }
  }
  const bridge: typeof fetch = async (_input, init) => {
    const signal = init?.signal
    const requestHeaders = await headers(signal)
    if (!deploymentId) {
      const url = `${base}/lm/deployments?scenarioId=orchestration&status=RUNNING`
      const deployments = z
        .object({ resources: z.array(z.object({ id: z.string(), status: z.string().optional() })) })
        .parse(await checkedJson(await fetcher(url, { headers: requestHeaders, signal }), url))
      deploymentId = deployments.resources.find(
        (item) => !item.status || item.status === 'RUNNING',
      )?.id
      if (!deploymentId)
        throw new Error('SAP AI Core 没有运行中的 orchestration 部署。请在服务商控制台启用部署。')
    }
    const body = z
      .object({
        model: z.string(),
        messages: z.array(z.unknown()),
        temperature: z.number().optional(),
        response_format: z.unknown().optional(),
        stream: z.boolean().optional(),
      })
      .parse(JSON.parse(String(init?.body)))
    const params = {
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(body.stream ? { stream_options: { include_usage: true } } : {}),
    }
    const response = await fetcher(
      `${base}/inference/deployments/${encodeURIComponent(deploymentId)}/v2/completion`,
      {
        ...init,
        headers: requestHeaders,
        body: JSON.stringify({
          config: {
            modules: {
              prompt_templating: {
                model: { name: body.model, params },
                prompt: { template: body.messages, response_format: body.response_format },
              },
            },
            ...(body.stream ? { stream: { enabled: true } } : {}),
          },
        }),
      },
    )
    if (response.status === 401) auth = undefined
    if (!response.ok) return response
    const responseHeaders = new Headers(response.headers)
    responseHeaders.delete('content-length')
    responseHeaders.delete('content-encoding')
    if (!body.stream) {
      const data = z.object({ final_result: z.unknown() }).parse(await response.json())
      return Response.json(data.final_result, { status: response.status, headers: responseHeaders })
    }
    if (!response.body) throw new Error('SAP AI Core 返回了空的流式响应。')
    const stream = parseJsonEventStream({
      stream: response.body,
      schema: z.object({ final_result: z.unknown().optional(), error: z.unknown().optional() }),
    }).pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          if (!chunk.success) throw chunk.error
          if (chunk.value.error)
            throw new Error(`SAP orchestration：${JSON.stringify(chunk.value.error)}`)
          if (chunk.value.final_result)
            controller.enqueue(
              new TextEncoder().encode(`data: ${JSON.stringify(chunk.value.final_result)}\n\n`),
            )
        },
      }),
    )
    responseHeaders.set('content-type', 'text/event-stream')
    return new Response(stream, { status: response.status, headers: responseHeaders })
  }
  return createOpenAICompatible({
    name: 'sap',
    baseURL: base,
    apiKey: 'service-credential',
    fetch: bridge,
    supportsStructuredOutputs: true,
    includeUsage: true,
  })
}

/** GitLab's model SDK also bundles filesystem/workflow clients. Direct-access tokens work over HTTP. */
export function createBrowserGitLab(options: Options) {
  const fetcher = options.fetch ?? fetch
  let auth: { token: string; headers: Record<string, string>; expires: number } | undefined
  const bridge: typeof fetch = async (input, init) => {
    if (!auth || auth.expires <= Date.now()) {
      const url = 'https://gitlab.com/api/v4/ai/third_party_agents/direct_access'
      const data = z
        .object({ token: z.string(), headers: z.record(z.string(), z.string()) })
        .parse(
          await checkedJson(
            await fetcher(url, {
              method: 'POST',
              signal: init?.signal,
              headers: {
                Authorization: `Bearer ${options.apiKey}`,
                'Content-Type': 'application/json',
              },
              body: '{}',
            }),
            url,
          ),
        )
      auth = { ...data, expires: Date.now() + 25 * 60 * 1000 }
    }
    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${auth.token}`)
    for (const [name, value] of Object.entries(auth.headers))
      if (name.toLowerCase() !== 'x-api-key') headers.set(name, value)
    const response = await fetcher(input, { ...init, headers })
    if (response.status === 401) auth = undefined
    return response
  }
  const upstream = createOpenAI({
    apiKey: 'direct-access',
    baseURL: 'https://cloud.gitlab.com/ai/v1/proxy/openai/v1',
    fetch: bridge,
  })
  return {
    languageModel: (id: string) => {
      // Models.dev uses Duo IDs; GitLab's upstream proxy expects OpenAI's model IDs.
      const model = id.replace(/^duo-chat-/, '').replace(/^(gpt-\d+)-(\d+)(?=-|$)/, '$1.$2')
      return upstream.responses(model)
    },
  }
}
