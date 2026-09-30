import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import acpMcpBridge from '../../src/acp-mcp-bridge.js'

const ENV_NAME = 'PI_ACP_MCP_SERVERS'

// Keep the bridge's `mcp.json` collision check away from the real agent directory.
const isolatedAgentDir = mkdtempSync(join(tmpdir(), 'pi-acp-bridge-agent-'))
process.env.PI_CODING_AGENT_DIR = isolatedAgentDir
test.after(() => rmSync(isolatedAgentDir, { recursive: true, force: true }))

type Listener = (event: unknown, ctx?: { isProjectTrusted?(): boolean }) => void | Promise<void>

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

async function sessionStart(listeners: Map<string, Listener>, projectTrusted = false): Promise<void> {
  await listeners.get('session_start')?.({ type: 'session_start' }, { isProjectTrusted: () => projectTrusted })
}

async function sessionStartError(listeners: Map<string, Listener>, projectTrusted = false): Promise<Error> {
  assert.ok(listeners.get('session_start'), 'expected a session_start report')
  try {
    await sessionStart(listeners, projectTrusted)
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
  await withDefinitions(definitions, async () => {
    const registered: Array<[string, unknown]> = []
    const listeners = loadBridge((name, config) => registered.push([name, config]))

    assert.deepEqual(registered, Object.entries(definitions))
    // Nothing failed, so session start reports nothing.
    await sessionStart(listeners)
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

test('ACP MCP bridge reports a session server that a same-named global mcp.json entry replaces', async t => {
  const configPath = join(isolatedAgentDir, 'mcp.json')
  writeFileSync(
    configPath,
    JSON.stringify({ mcpServers: { webagent: { url: 'http://127.0.0.1:9/mcp', enabled: false } } })
  )
  t.after(() => rmSync(configPath, { force: true }))

  await withDefinitions(
    { webagent: { url: 'https://webagent.test/mcp' }, other: { url: 'https://other.test/mcp' } },
    async () => {
      const registered: string[] = []
      const listeners = loadBridge(name => registered.push(name))

      // Pi still receives the registration; the configured entry wins inside Pi.
      assert.deepEqual(registered, ['webagent', 'other'])
      const error = await sessionStartError(listeners)
      assert.equal(
        error.message,
        `pi-acp MCP bridge: 1 of 2 session MCP server(s) did not attach (webagent: Pi uses the same-named entry in ${configPath} instead). The session continues without them.`
      )
    }
  )
})

test('ACP MCP bridge reports a same-named project mcp.json entry only for a trusted project', async t => {
  const project = mkdtempSync(join(tmpdir(), 'pi-acp-bridge-project-'))
  mkdirSync(join(project, '.pi'))
  writeFileSync(join(project, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: { webagent: { command: 'node' } } }))
  const previousCwd = process.cwd()
  process.chdir(project)
  t.after(() => {
    process.chdir(previousCwd)
    rmSync(project, { recursive: true, force: true })
  })

  await withDefinitions({ webagent: { url: 'https://webagent.test/mcp' } }, async () => {
    const error = await sessionStartError(
      loadBridge(() => {}),
      true
    )
    assert.match(error.message, /webagent: Pi uses the same-named entry in .*\.pi\/mcp\.json instead\)/)
    // Pi ignores the project file of an untrusted project, so nothing is replaced.
    await sessionStart(
      loadBridge(() => {}),
      false
    )
  })
})

test('ACP MCP bridge ignores same-named mcp.json entries Pi would skip as invalid', async t => {
  const configPath = join(isolatedAgentDir, 'mcp.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        missing: { enabled: false },
        legacy: { type: 'sse', url: 'https://legacy.test/sse' },
        notObject: 'x'
      }
    })
  )
  t.after(() => rmSync(configPath, { force: true }))

  await withDefinitions(
    {
      missing: { url: 'https://missing.test/mcp' },
      legacy: { url: 'https://legacy.test/mcp' },
      notObject: { url: 'https://not-object.test/mcp' }
    },
    async () => {
      await sessionStart(loadBridge(() => {}))
    }
  )
})
