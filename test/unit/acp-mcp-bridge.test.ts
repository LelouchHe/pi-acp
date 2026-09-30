import test from 'node:test'
import assert from 'node:assert/strict'
import acpMcpBridge from '../../src/acp-mcp-bridge.js'

const ENV_NAME = 'PI_ACP_MCP_SERVERS'

type Listener = () => void | Promise<void>

function withEncoded(encoded: string | undefined, run: () => Promise<void> | void): Promise<void> {
  const previous = process.env[ENV_NAME]
  if (encoded === undefined) delete process.env[ENV_NAME]
  else process.env[ENV_NAME] = encoded
  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (previous === undefined) delete process.env[ENV_NAME]
      else process.env[ENV_NAME] = previous
    })
}

function withDefinitions(definitions: Record<string, Record<string, unknown>>, run: () => Promise<void> | void) {
  return withEncoded(Buffer.from(JSON.stringify(definitions)).toString('base64url'), run)
}

function loadBridge(registerMcpServer?: (name: string, config: Record<string, unknown>) => void) {
  const listeners = new Map<string, Listener>()
  acpMcpBridge({
    ...(registerMcpServer ? { registerMcpServer } : {}),
    on(event, listener) {
      listeners.set(event, listener)
    }
  })
  return listeners
}

async function sessionStartError(listeners: Map<string, Listener>): Promise<Error> {
  const start = listeners.get('session_start')
  assert.ok(start, 'expected a session_start report')
  try {
    await start()
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error('expected the bridge to report failures')
}

test('ACP MCP bridge registers every definition with Pi while the extension loads', async () => {
  const definitions = {
    remote: { url: 'https://example.test/mcp', headers: { Authorization: 'Bearer test' }, exposure: 'direct' },
    local: { command: 'node', args: ['server.mjs'], env: {} }
  }
  await withDefinitions(definitions, () => {
    const registered: Array<[string, unknown]> = []
    const listeners = loadBridge((name, config) => registered.push([name, config]))

    assert.deepEqual(registered, Object.entries(definitions))
    // Nothing failed, so there is nothing to report at session start.
    assert.equal(listeners.size, 0)
  })
})

test('ACP MCP bridge does nothing without supplied definitions', async () => {
  await withEncoded(undefined, () => {
    let calls = 0
    const listeners = loadBridge(() => {
      calls += 1
    })
    assert.equal(calls, 0)
    assert.equal(listeners.size, 0)
  })
})

test('ACP MCP bridge keeps the registrations that did attach and reports the rest at session start', async () => {
  await withDefinitions(
    { attached: { url: 'https://attached.test/mcp' }, rejected: { url: 'https://rejected.test/mcp' } },
    async () => {
      const registered: string[] = []
      // A throwing factory would make Pi discard every registration, so the
      // bridge must load cleanly and defer its report.
      const listeners = loadBridge(name => {
        if (name === 'rejected') throw new Error('invalid server')
        registered.push(name)
      })

      assert.deepEqual(registered, ['attached'])
      const error = await sessionStartError(listeners)
      assert.equal(
        error.message,
        'pi-acp MCP bridge: 1 of 2 session MCP server(s) did not attach (rejected: invalid server). The session continues without them.'
      )
    }
  )
})

test('ACP MCP bridge reports a Pi without built-in MCP support instead of failing to load', async () => {
  await withDefinitions({ remote: { url: 'https://example.test/mcp' } }, async () => {
    const error = await sessionStartError(loadBridge())
    assert.match(error.message, /^pi-acp MCP bridge: 1 of 1 session MCP server\(s\) did not attach/)
    assert.match(error.message, /remote: this Pi version has no built-in MCP support/)
  })
})

test('ACP MCP bridge reports undecodable definitions', async () => {
  await withEncoded('not base64 json', async () => {
    const error = await sessionStartError(loadBridge(() => assert.fail('nothing should register')))
    assert.match(error.message, /^pi-acp MCP bridge: could not read session MCP servers \(could not decode/)
  })
})
