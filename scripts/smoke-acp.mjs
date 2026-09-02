import { spawn } from 'node:child_process'

const cwd = process.cwd()

// Build first so Zed-style invocation (node dist/index.js) works.
await new Promise((resolve, reject) => {
  const p = spawn('npm', ['run', 'build'], { stdio: 'inherit', cwd })
  p.on('exit', code => (code === 0 ? resolve() : reject(new Error(`build failed: ${code}`))))
})

const child = spawn('node', ['dist/index.js'], {
  cwd,
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env
})

child.stdout.setEncoding('utf8')
child.stdout.on('data', chunk => {
  process.stdout.write(chunk)
})

let completed = false

function describeError(error) {
  if (!error || typeof error !== 'object') return String(error)
  const message = typeof error.message === 'string' ? error.message : JSON.stringify(error)
  const data = error.data === undefined ? '' : ` data=${JSON.stringify(error.data)}`
  return `${message}${data}`
}

function fail(reason) {
  if (completed) return
  completed = true
  process.stderr.write(`ACP smoke failed: ${reason}\n`)
  child.kill('SIGTERM')
  process.exitCode = 1
}

child.on('error', error => {
  fail(`could not start pi-acp: ${error instanceof Error ? error.message : String(error)}`)
})

child.on('exit', (code, signal) => {
  if (!completed) fail(`pi-acp exited before smoke completed (code=${code}, signal=${signal})`)
})

function send(obj) {
  if (completed) return
  try {
    child.stdin.write(JSON.stringify(obj) + '\n')
  } catch (error) {
    fail(`could not send ${obj.method ?? 'request'}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// Basic ACP handshake + one prompt.
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } })
send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: cwd, mcpServers: [] } })

// We'll send prompt a moment later; sessionId is in response to id=2.
let sessionId = null
let buffer = ''
child.stdout.on('data', chunk => {
  buffer += chunk
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''

  for (const line of lines) {
    if (!line.trim()) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }

    if (msg?.error) {
      fail(`request ${msg.id ?? '<notification>'}: ${describeError(msg.error)}`)
      continue
    }

    if (msg?.id === 2 && !sessionId) {
      if (typeof msg.result?.sessionId !== 'string' || msg.result.sessionId.length === 0) {
        fail('session/new returned no sessionId')
        continue
      }
      sessionId = msg.result.sessionId
      send({
        jsonrpc: '2.0',
        id: 3,
        method: 'session/prompt',
        params: {
          sessionId,
          prompt: [{ type: 'text', text: 'Say hello in one short sentence.' }]
        }
      })
    }

    if (msg?.id === 3) {
      // Turn finished successfully.
      completed = true
      setTimeout(() => child.kill('SIGTERM'), 50)
    }
  }
})
