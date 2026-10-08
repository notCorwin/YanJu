import type { Appearance } from './types'

/** Settings may only override root tokens; no component receives bespoke visual values. */
export function applyAppearance(settings: Appearance) {
  const root = document.documentElement
  root.style.setProperty('--font-ui-size', `${Math.min(18, Math.max(10, settings.fontUi)) / 16}rem`)
  root.style.setProperty(
    '--font-chat-size',
    `${Math.min(24, Math.max(11, settings.fontChat)) / 16}rem`,
  )
  const family = settings.fontFamily.replaceAll("'", '')
  root.style.setProperty(
    '--font-body',
    family.includes(',') ? family : `"${family}", "Noto Serif SC", serif`,
  )
  root.style.setProperty('--font-chat', 'var(--font-body)')
  root.style.setProperty(
    '--background-image',
    settings.bgImage ? `url(${JSON.stringify(settings.bgImage)})` : 'none',
  )
  root.style.setProperty(
    '--background-opacity',
    String(Math.min(100, Math.max(0, settings.bgOpacity)) / 100),
  )
}
