import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { performance } from 'node:perf_hooks'

const started = performance.now()
const children = new Set()
const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
let failed = false

function processTree() {
  const owned = new Set([...children].map((child) => child.pid))
  if (process.platform === 'win32' || !owned.size) return owned
  const rows = execFileSync('ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((row) => row.trim().split(/\s+/).map(Number))
  let found = true
  while (found) {
    found = false
    for (const [pid, parent] of rows)
      if (owned.has(parent) && !owned.has(pid)) {
        owned.add(pid)
        found = true
      }
  }
  return owned
}

function stop() {
  const owned = processTree()
  for (const pid of [...owned].reverse()) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* Already exited. */
    }
  }
  setTimeout(() => {
    for (const pid of owned) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* Already exited. */
      }
    }
  }, 500).unref()
}

const deadline = setTimeout(() => {
  failed = true
  console.error('本地 CI 达到时间预算，正在停止所有后台检查（总上限 60 秒）。')
  stop()
}, 59_000)
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    failed = true
    stop()
  })

async function run(script) {
  const stage = performance.now()
  let output = ''
  const child = spawn(executable, ['run', script], {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: '1' },
  })
  children.add(child)
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      output = (output + chunk.toString()).slice(-2_000_000)
    })
  const code = await new Promise((resolve) => {
    child.once('error', (error) => {
      output += error.message
      resolve(1)
    })
    child.once('close', (code) => resolve(code ?? 1))
  })
  children.delete(child)
  console.log(
    `${code === 0 ? '通过' : '失败'} ${script} (${((performance.now() - stage) / 1000).toFixed(1)}s)`,
  )
  if (code !== 0) {
    failed = true
    console.error(output)
    stop()
  } else if (script === 'test' || script === 'test:e2e:core') {
    console.log(
      output
        .split('\n')
        .filter((line) => /Test Files|Tests\s+|\d+ passed/.test(line))
        .join('\n'),
    )
  }
}

try {
  if (!process.env.YANJU_E2E_PORT) {
    const server = createServer()
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    process.env.YANJU_E2E_PORT = String(server.address().port)
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
  // Keep browser workers separate from domain tests to avoid resource contention.
  await Promise.all(['check:tokens', 'lint', 'test', 'build'].map(run))
  if (!failed) await run('test:e2e:core')
} finally {
  clearTimeout(deadline)
  stop()
}
console.log(`本地 CI 总耗时 ${((performance.now() - started) / 1000).toFixed(1)}s`)
process.exitCode = failed ? 1 : 0
