import test from 'node:test'
import assert from 'node:assert/strict'
import acpMcpBridge from '../../src/acp-mcp-bridge.js'

const ENV_NAME = 'PI_ACP_MCP_SERVERS'

test('ACP MCP bridge registers definitions for one Pi session and disposes them at shutdown', async () => {
  const previous = process.env[ENV_NAME]
  process.env[ENV_NAME] = Buffer.from(
    JSON.stringify({
      remote: { url: 'https://example.test/mcp', headers: { Authorization: 'Bearer test' } }
    })
  ).toString('base64url')

  try {
    const handlers = new Map<string, () => void | Promise<void>>()
    const registrations: Array<{ name: string; definition: unknown }> = []
    let disposeCount = 0
    acpMcpBridge({
      on(event, handler) {
        handlers.set(event, handler)
      },
      events: {
        emit(_event, request) {
          registrations.push({ name: request.name, definition: request.definition })
          request.result = {
            ok: true,
            registration: {
              async dispose() {
                disposeCount += 1
              }
            }
          }
        }
      }
    })

    await handlers.get('session_start')?.()
    assert.deepEqual(registrations, [
      {
        name: 'remote',
        definition: { url: 'https://example.test/mcp', headers: { Authorization: 'Bearer test' } }
      }
    ])

    await handlers.get('session_shutdown')?.()
    assert.equal(disposeCount, 1)
  } finally {
    if (previous === undefined) delete process.env[ENV_NAME]
    else process.env[ENV_NAME] = previous
  }
})

test('ACP MCP bridge fails closed when pi-mcp-adapter is unavailable', async () => {
  const previous = process.env[ENV_NAME]
  process.env[ENV_NAME] = Buffer.from(JSON.stringify({ remote: { url: 'https://example.test/mcp' } })).toString(
    'base64url'
  )

  try {
    const handlers = new Map<string, () => void | Promise<void>>()
    acpMcpBridge({
      on(event, handler) {
        handlers.set(event, handler)
      },
      events: { emit() {} }
    })

    const start = handlers.get('session_start')
    assert.ok(start)
    await assert.rejects(async () => {
      await start()
    }, /pi-acp MCP bridge: pi-mcp-adapter is not installed or enabled/)
  } finally {
    if (previous === undefined) delete process.env[ENV_NAME]
    else process.env[ENV_NAME] = previous
  }
})
