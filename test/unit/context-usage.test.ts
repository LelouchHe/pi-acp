import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession, toAcpPromptUsage } from '../../src/acp/session.js'
import { SESSION_STATS_TIMEOUT_MS } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  constructor(private readonly session: any) {}

  async create() {
    return this.session
  }

  maybeGet(sessionId: string) {
    if (sessionId !== this.session.sessionId) return undefined
    return this.session
  }

  get(sessionId: string) {
    if (sessionId !== this.session.sessionId) {
      throw new Error(`Unknown sessionId: ${sessionId}`)
    }
    return this.session
  }
}

/** Wait for the agent's prompt path to reach pi before emitting turn events. */
async function waitForPromptStart(proc: FakePiRpcProcess): Promise<void> {
  const deadline = Date.now() + 1_000
  while (proc.prompts.length === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  assert.equal(proc.prompts.length, 1)
}

/** Let the `setTimeout(..., 0)` continuations scheduled after session/new or session/load run. */
async function drainScheduledWork(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

function makeSession(proc: FakePiRpcProcess, conn: FakeAgentSideConnection): PiAcpSession {
  return new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
}

test('PiAcpSession: context usage request specifies the auxiliary timeout', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  let requestedTimeout: number | undefined
  proc.getSessionStats = async (timeoutMs?: number) => {
    requestedTimeout = timeoutMs
    return { contextUsage: { tokens: 100, contextWindow: 100_000 } }
  }

  await makeSession(proc, conn).publishContextUsage()

  assert.equal(requestedTimeout, SESSION_STATS_TIMEOUT_MS)
  assert.deepEqual(conn.updates, [
    { sessionId: 's1', update: { sessionUpdate: 'usage_update', used: 100, size: 100_000 } }
  ])
})

test('PiAcpAgent: newSession publishes context usage only after the response is returned', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.sessionStats = { contextUsage: { tokens: 1_234, contextWindow: 100_000 } }
  proc.getState = async () => ({ thinkingLevel: 'medium' })
  const session = makeSession(proc, conn)

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  const result = await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)
  assert.equal(result.sessionId, 's1')
  assert.equal(
    conn.updates.some(u => u.update.sessionUpdate === 'usage_update'),
    false
  )

  await drainScheduledWork()

  assert.deepEqual(
    conn.updates.filter(u => u.update.sessionUpdate === 'usage_update'),
    [{ sessionId: 's1', update: { sessionUpdate: 'usage_update', used: 1_234, size: 100_000 } }]
  )
})

test('PiAcpAgent: newSession tolerates a failing get_session_stats', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.sessionStatsError = new Error('pi get_session_stats failed: unsupported')
  proc.getState = async () => ({ thinkingLevel: 'medium' })
  const session = makeSession(proc, conn)

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  const result = await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)
  assert.equal(result.sessionId, 's1')

  await drainScheduledWork()

  assert.equal(
    conn.updates.some(u => u.update.sessionUpdate === 'usage_update'),
    false
  )
})

test('toAcpPromptUsage: maps cumulative session tokens to the ACP usage payload', () => {
  assert.deepEqual(
    toAcpPromptUsage({ tokens: { input: 1_200, output: 340, cacheRead: 5_000, cacheWrite: 60, total: 6_600 } }),
    {
      totalTokens: 6_600,
      inputTokens: 1_200,
      outputTokens: 340,
      cachedReadTokens: 5_000,
      cachedWriteTokens: 60
    }
  )
})

test('toAcpPromptUsage: omits optional cache totals when pi does not report them', () => {
  assert.deepEqual(toAcpPromptUsage({ tokens: { total: 30, input: 10, output: 20 } }), {
    totalTokens: 30,
    inputTokens: 10,
    outputTokens: 20
  })
})

test('toAcpPromptUsage: omits usage unless every required total is trustworthy', () => {
  assert.equal(toAcpPromptUsage(undefined), null)
  assert.equal(toAcpPromptUsage({}), null)
  // Context occupancy alone is not session usage.
  assert.equal(toAcpPromptUsage({ contextUsage: { tokens: 10, contextWindow: 100 } }), null)
  assert.equal(toAcpPromptUsage({ tokens: { input: 1, output: 2 } }), null)
  assert.equal(toAcpPromptUsage({ tokens: { total: 3, input: 1 } }), null)
  assert.equal(toAcpPromptUsage({ tokens: { total: -1, input: 1, output: 2 } }), null)
  assert.equal(toAcpPromptUsage({ tokens: { total: 3.5, input: 1, output: 2 } }), null)
  assert.equal(toAcpPromptUsage({ tokens: { total: '3', input: 1, output: 2 } }), null)
})

test('PiAcpAgent: prompt response carries cumulative session usage', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.sessionStats = {
    tokens: { input: 1_000, output: 250, cacheRead: 4_000, cacheWrite: 50, total: 5_300 },
    contextUsage: { tokens: 12_000, contextWindow: 200_000 }
  }

  const session = makeSession(proc, conn)
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  const prompt = agent.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: 'hello' }] } as any)
  await waitForPromptStart(proc)
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })

  assert.deepEqual(await prompt, {
    stopReason: 'end_turn',
    usage: {
      totalTokens: 5_300,
      inputTokens: 1_000,
      outputTokens: 250,
      cachedReadTokens: 4_000,
      cachedWriteTokens: 50
    }
  })
  // One bounded stats query feeds both usage_update and the prompt response.
  assert.equal(proc.getSessionStatsCount, 1)
})

test('PiAcpAgent: prompt response omits usage when pi reports no token totals', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.sessionStats = { contextUsage: { tokens: 1_234, contextWindow: 100_000 } }

  const session = makeSession(proc, conn)
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  const prompt = agent.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: 'hello' }] } as any)
  await waitForPromptStart(proc)
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })

  assert.deepEqual(await prompt, { stopReason: 'end_turn' })
})

test('PiAcpAgent: switching the model config option refreshes context usage', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const state: { thinkingLevel: string; model: { provider: string; id: string } } = {
    thinkingLevel: 'medium',
    model: { provider: 'test', id: 'alpha' }
  }
  proc.getAvailableModels = async () => ({
    models: [
      { provider: 'test', id: 'alpha', name: 'Alpha' },
      { provider: 'test', id: 'beta', name: 'Beta' }
    ]
  })
  proc.getState = async () => state
  ;(proc as any).setModel = async (provider: string, modelId: string) => {
    state.model = { provider, id: modelId }
    proc.sessionStats = { contextUsage: { tokens: 500, contextWindow: modelId === 'beta' ? 200_000 : 100_000 } }
  }
  proc.sessionStats = { contextUsage: { tokens: 500, contextWindow: 100_000 } }

  const session = makeSession(proc, conn)
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  await agent.setSessionConfigOption({ sessionId: 's1', configId: 'model', value: 'test/beta' } as any)

  assert.deepEqual(
    conn.updates.map(u => u.update.sessionUpdate),
    ['current_mode_update', 'config_option_update', 'usage_update']
  )
  assert.deepEqual(conn.updates.at(-1), {
    sessionId: 's1',
    update: { sessionUpdate: 'usage_update', used: 500, size: 200_000 }
  })
})

test('PiAcpAgent: unstable_setSessionModel refreshes context usage', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const state: { thinkingLevel: string; model: { provider: string; id: string } } = {
    thinkingLevel: 'medium',
    model: { provider: 'test', id: 'alpha' }
  }
  proc.getAvailableModels = async () => ({
    models: [
      { provider: 'test', id: 'alpha', name: 'Alpha' },
      { provider: 'test', id: 'beta', name: 'Beta' }
    ]
  })
  proc.getState = async () => state
  ;(proc as any).setModel = async (provider: string, modelId: string) => {
    state.model = { provider, id: modelId }
    proc.sessionStats = { contextUsage: { tokens: 700, contextWindow: modelId === 'beta' ? 200_000 : 100_000 } }
  }
  proc.sessionStats = { contextUsage: { tokens: 700, contextWindow: 100_000 } }

  const session = makeSession(proc, conn)
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  await agent.unstable_setSessionModel({ sessionId: 's1', modelId: 'test/beta' })

  assert.equal(proc.getSessionStatsCount, 1)
  assert.deepEqual(
    conn.updates.map(u => u.update.sessionUpdate),
    ['current_mode_update', 'config_option_update', 'usage_update']
  )
  assert.deepEqual(conn.updates.at(-1), {
    sessionId: 's1',
    update: { sessionUpdate: 'usage_update', used: 700, size: 200_000 }
  })
})

test('PiAcpAgent: switching the thinking level does not publish context usage', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const state: { thinkingLevel: string; model: { provider: string; id: string } } = {
    thinkingLevel: 'medium',
    model: { provider: 'test', id: 'alpha' }
  }
  proc.getState = async () => state
  ;(proc as any).setThinkingLevel = async (level: string) => {
    state.thinkingLevel = level
  }
  proc.sessionStats = { contextUsage: { tokens: 500, contextWindow: 100_000 } }

  const session = makeSession(proc, conn)
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  await agent.setSessionConfigOption({ sessionId: 's1', configId: 'thought_level', value: 'high' } as any)

  assert.equal(proc.getSessionStatsCount, 0)
  assert.equal(
    conn.updates.some(u => u.update.sessionUpdate === 'usage_update'),
    false
  )
})
