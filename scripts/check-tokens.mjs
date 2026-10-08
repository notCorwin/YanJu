import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(process.argv[2] || 'src')
const rules = [
  ['裸颜色', /#[\da-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|oklab)\s*\(/i],
  ['独立视觉数值', /\b(?:text|rounded(?:-[trblse]{1,2})?|shadow|bg|fill|stroke)-\[/],
  ['独立动效', /\b(?:duration|delay)-\d+|\bease-\[|\banimate-\[/],
  [
    '独立调色板',
    /\b(?:bg|text|border|ring|fill|stroke)-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d+)\b/,
  ],
  ['组件透明度颜色', /\b(?:bg|text|border|ring|fill|stroke)-[a-z-]+\/\d+/],
  [
    '组件内视觉样式',
    /\b(?:fontSize|fontFamily|borderRadius|boxShadow|animationDuration|transitionDuration)\s*:/,
  ],
]
const failures = []
function visit(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const filename = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      visit(filename)
      continue
    }
    if (!/\.(tsx?|css)$/.test(filename) || filename === path.join(root, 'styles/tokens.css'))
      continue
    const lines = fs.readFileSync(filename, 'utf8').split('\n')
    lines.forEach((line, i) => {
      for (const [label, pattern] of rules) {
        if (label === '组件内视觉样式' && !filename.endsWith('.tsx')) continue
        if (pattern.test(line)) failures.push(`${path.relative(root, filename)}:${i + 1} ${label}`)
      }
      if (
        filename.endsWith('.css') &&
        /(?:color|font|radius|shadow|animation|transition|padding|margin)\s*:/.test(line)
      )
        failures.push(`${path.relative(root, filename)}:${i + 1} CSS 视觉定义必须放在 tokens.css`)
    })
  }
}
visit(root)
if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log('Design Token 检查通过：所有视觉规范均引用共享 Token。')
