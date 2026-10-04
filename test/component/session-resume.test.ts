import test from 'node:test'
import assert from 'node:assert/strict'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

const HISTORY_UPDATES = new Set(['user_message_chunk', 'agent_message_chunk', 'tool_call', 'tool_call_update'])

function historyUpdates(conn: FakeAgentSideConnection) {
  return conn.updates.filter(u => HISTORY_UPDATES.has((u as any).update?.sessionUpdate))
}

function makeProc() {
  return {
    onEvent: () => () => {},
    getMessages: async () => ({
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] }
      ]
    }),
    getAvailableThinkingLevels: async () => ['medium'],
    getAvailableModels: async () => ({ models: [{ provider: 'test', id: 'model', name: 'Model' }] }),
    getState: async () => ({ thinkingLevel: 'medium', model: { provider: 'test', id: 'model' } }),
    getCommands: async () => ({ commands: [] }),
    getSessionStats: async () => ({ contextUsage: { tokens: 10, contextWindow: 100 } }),
    dispose() {}
  }
}

const STORED = {
  sessionId: 'sess-1',
  cwd: '/tmp/project',
  sessionFile: '/tmp/project/session.jsonl'
}

const RESTORED_MCP = [
  {
    type: 'http',
    name: 'restored-tools',
    url: 'https://example.test/mcp',
    headers: [],
    _meta: { directTools: true }
  }
]

function makeAgent(conn: FakeAgentSideConnection) {
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).store = {
    get: (sessionId: string) => (sessionId === STORED.sessionId ? { ...STORED } : null),
    upsert() {}
  }
  return agent
}

test('PiAcpAgent: initialize advertises session resume capability', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))

  const res = await agent.initialize({ protocolVersion: 1 } as any)

  assert.deepEqual(res.agentCapabilities?.sessionCapabilities, {
    list: {},
    delete: {},
    resume: {}
  })
})

test('PiAcpAgent: resumeSession restores a stored session without replaying history', async () => {
  const conn = new FakeAgentSideConnection()
  const spawnCalls: any[] = []
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    spawnCalls.push(params)
    return makeProc() as any
  }

  try {
    const agent = makeAgent(conn)

    const res: any = await agent.resumeSession({
      sessionId: STORED.sessionId,
      cwd: STORED.cwd,
      mcpServers: RESTORED_MCP
    } as any)

    // Resume reconnects to the stored session file with the requested cwd and MCP servers.
    assert.deepEqual(spawnCalls, [
      {
        cwd: STORED.cwd,
        sessionPath: STORED.sessionFile,
        piCommand: process.env.PI_ACP_PI_COMMAND,
        mcpServers: {
          'restored-tools': {
            url: 'https://example.test/mcp',
            headers: {},
            exposure: 'direct'
          }
        }
      }
    ])

    // Resume returns the same configuration shape load returns.
    assert.equal(res.configOptions.find((option: any) => option.id === 'model')?.currentValue, 'test/model')
    assert.equal(res.modes.currentModeId, 'medium')
    assert.equal(res.models.currentModelId, 'test/model')
    assert.equal(res._meta?.piAcp?.startupInfo, null)

    // Resume must not replay conversation history.
    assert.deepEqual(historyUpdates(conn), [])

    // Let the scheduled usage/commands notifications run; replay must still be absent.
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))
    assert.deepEqual(historyUpdates(conn), [])
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: loadSession still replays history for the same stored session', async () => {
  const conn = new FakeAgentSideConnection()
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => makeProc() as any

  try {
    const agent = makeAgent(conn)

    await agent.loadSession({
      sessionId: STORED.sessionId,
      cwd: STORED.cwd,
      mcpServers: []
    } as any)

    const kinds = historyUpdates(conn).map(u => (u as any).update.sessionUpdate)
    assert.ok(kinds.includes('user_message_chunk'))
    assert.ok(kinds.includes('agent_message_chunk'))
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: resumeSession of a live session is idempotent', async () => {
  const conn = new FakeAgentSideConnection()
  const spawnCalls: any[] = []
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    spawnCalls.push(params)
    return makeProc() as any
  }

  try {
    const agent = makeAgent(conn)

    const first: any = await agent.resumeSession({
      sessionId: STORED.sessionId,
      cwd: STORED.cwd,
      mcpServers: []
    } as any)

    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))
    const updatesAfterFirstResume = conn.updates.length

    const second: any = await agent.resumeSession({
      sessionId: STORED.sessionId,
      cwd: STORED.cwd,
      mcpServers: []
    } as any)

    // No teardown and rebuild: the live subprocess is reused.
    assert.equal(spawnCalls.length, 1)
    assert.deepEqual(second.configOptions, first.configOptions)
    assert.equal(second.modes.currentModeId, 'medium')
    assert.equal(second.models.currentModelId, 'test/model')

    // Nothing is replayed or re-advertised for an already-live session.
    assert.equal(conn.updates.length, updatesAfterFirstResume)
    assert.deepEqual(historyUpdates(conn), [])
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})
