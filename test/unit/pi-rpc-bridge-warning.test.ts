import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

const FAKE_PI = `#!/usr/bin/env node
const send = msg => process.stdout.write(JSON.stringify(msg) + '\\n')
send({
  type: 'extension_error',
  extensionPath: '/tmp/acp-mcp-bridge.js',
  event: 'session_start',
  error: 'pi-acp MCP bridge: 1 of 1 session MCP server(s) did not attach (remote: no installed Pi extension accepts session MCP servers). The session continues without them.'
})
send({
  type: 'extension_error',
  extensionPath: '/tmp/some-other-extension.js',
  event: 'session_start',
  error: 'some other extension failed'
})
let buffer = ''
process.stdin.on('data', chunk => {
  buffer += chunk.toString()
  let index
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.type === 'get_state') send({ type: 'response', id: msg.id, success: true, data: {} })
  }
})
process.stdin.on('end', () => process.exit(0))
`

test('PiRpcProcess: a bridge warning is logged and never fails the session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-bridge-warning-'))
  const script = join(root, 'pi')
  writeFileSync(script, FAKE_PI, 'utf-8')
  chmodSync(script, 0o755)

  const logged: string[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '))
  }

  try {
    const proc = await PiRpcProcess.spawn({
      cwd: process.cwd(),
      piCommand: script,
      mcpServers: { remote: { url: 'https://example.test/mcp' } }
    })

    try {
      // Session-scoped MCP wiring is best effort: the bridge's report is a
      // warning, not a reason to fail session creation.
      assert.deepEqual(logged, [
        'pi-acp MCP bridge: 1 of 1 session MCP server(s) did not attach (remote: no installed Pi extension accepts session MCP servers). The session continues without them.'
      ])
    } finally {
      proc.dispose()
    }
  } finally {
    console.error = originalError
    rmSync(root, { recursive: true, force: true })
  }
})
