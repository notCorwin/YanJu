import type { ApiProtocol, Channel, ChannelCapability } from './types'

export const protocolLabels: Record<ApiProtocol, string> = {
  responses: 'Responses',
  'chat-completions': 'Chat Completions',
}

function hash(value: string) {
  let result = 2166136261
  for (const char of value) result = Math.imul(result ^ char.charCodeAt(0), 16777619)
  return (result >>> 0).toString(16)
}

export function channelFingerprint(channel: Channel) {
  const identity = JSON.stringify([
    channel.baseUrl,
    channel.apiKey,
    channel.model,
    channel.apiMode,
    channel.temperature,
    channel.maxOutputTokens,
    channel.contextWindow,
  ])
  return `${channel.baseUrl}|${channel.model}|${channel.apiMode}|${hash(identity)}`
}

export function channelIsReady(channel: Channel) {
  const capability = channel.capability
  if (!capability?.ok || capability.fingerprint !== channelFingerprint(channel)) return false
  const protocol = capability.protocol
  if (!protocol || (channel.apiMode !== 'auto' && channel.apiMode !== protocol)) return false
  const checks = capability.checks?.[protocol]
  return checks?.nonStreaming === 'passed' && checks.streaming === 'passed'
}

/** Untested channels use the preferred protocol only for estimating their budget. */
export function estimatedProtocol(channel: Channel): ApiProtocol {
  if (channel.apiMode !== 'auto') return channel.apiMode
  return channelIsReady(channel) ? channel.capability!.protocol! : 'responses'
}

export function withCapability(channel: Channel, capability: ChannelCapability): Channel {
  return {
    ...channel,
    capability,
    calibration:
      channel.capability?.protocol === capability.protocol ? channel.calibration : undefined,
  }
}
