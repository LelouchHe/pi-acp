import test from 'node:test'
import assert from 'node:assert/strict'
import acpMcpBridge from '../../src/acp-mcp-bridge.js'

const ENV_NAME = 'PI_ACP_MCP_SERVERS'

type Registration = { dispose(): Promise<void> }
type RuntimeRegistrationRequest = {
  version: 1
  name: string
  definition: Record<string, unknown>
  result?: { ok: true; registration: Registration } | { ok: false; error: Error }
}

function withDefinitions(
  definitions: Record<string, Record<string, unknown>>,
  run: () => Promise<void>
): Promise<void> {
  const previous = process.env[ENV_NAME]
  process.env[ENV_NAME] = Buffer.from(JSON.stringify(definitions)).toString('base64url')
  return run().finally(() => {
    if (previous === undefined) delete process.env[ENV_NAME]
    else process.env[ENV_NAME] = previous
  })
}

function createBridge(emit: (request: RuntimeRegistrationRequest) => void) {
  const handlers = new Map<string, () => void | Promise<void>>()
  acpMcpBridge({
    on(event, handler) {
      handlers.set(event, handler)
    },
    events: {
      emit(_event, request) {
        emit(request)
      }
    }
  })
  return handlers
}

async function startSession(handlers: Map<string, () => void | Promise<void>>): Promise<Error> {
  const start = handlers.get('session_start')
  assert.ok(start)
  try {
    await start()
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error('expected the bridge to report failures')
}

test('ACP MCP bridge registers definitions for one Pi session and disposes them at shutdown', async () => {
  await withDefinitions(
    { remote: { url: 'https://example.test/mcp', headers: { Authorization: 'Bearer test' } } },
    async () => {
      const registrations: Array<{ name: string; definition: unknown }> = []
      let disposeCount = 0
      const handlers = createBridge(request => {
        registrations.push({ name: request.name, definition: request.definition })
        request.result = {
          ok: true,
          registration: {
            async dispose() {
              disposeCount += 1
            }
          }
        }
      })

      const start = handlers.get('session_start')
      assert.ok(start)
      await start()
      assert.deepEqual(registrations, [
        {
          name: 'remote',
          definition: { url: 'https://example.test/mcp', headers: { Authorization: 'Bearer test' } }
        }
      ])

      await handlers.get('session_shutdown')?.()
      assert.equal(disposeCount, 1)
    }
  )
})

test('ACP MCP bridge reports unattached servers without naming a specific extension', async () => {
  await withDefinitions({ remote: { url: 'https://example.test/mcp' } }, async () => {
    const handlers = createBridge(() => {})
    const error = await startSession(handlers)

    assert.match(error.message, /^pi-acp MCP bridge: 1 of 1 session MCP server\(s\) did not attach/)
    assert.match(error.message, /remote: no installed Pi extension accepts session MCP servers/)
    assert.doesNotMatch(error.message, /pi-mcp-adapter/)
  })
})

test('ACP MCP bridge keeps the registrations that did attach', async () => {
  await withDefinitions(
    { attached: { url: 'https://attached.test/mcp' }, missing: { url: 'https://missing.test/mcp' } },
    async () => {
      let disposeCount = 0
      const handlers = createBridge(request => {
        if (request.name !== 'attached') return
        request.result = {
          ok: true,
          registration: {
            async dispose() {
              disposeCount += 1
            }
          }
        }
      })

      const error = await startSession(handlers)
      assert.match(error.message, /1 of 2 session MCP server\(s\) did not attach/)
      assert.match(error.message, /missing: no installed Pi extension accepts session MCP servers/)

      // The attached server stays registered: a partial failure must not roll
      // back what already works, and the session keeps running.
      assert.equal(disposeCount, 0)
      await handlers.get('session_shutdown')?.()
      assert.equal(disposeCount, 1)
    }
  )
})

test('ACP MCP bridge reports the reason an extension rejected a definition', async () => {
  await withDefinitions({ remote: { url: 'https://example.test/mcp' } }, async () => {
    const handlers = createBridge(request => {
      request.result = { ok: false, error: new Error('duplicate server name') }
    })

    const error = await startSession(handlers)
    assert.match(error.message, /remote: duplicate server name/)
  })
})
