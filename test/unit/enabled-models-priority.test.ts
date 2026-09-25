import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

const MODELS = [
  { provider: 'test', id: 'alpha', name: 'Alpha' },
  { provider: 'test', id: 'beta', name: 'Beta' },
  { provider: 'test', id: 'gamma', name: 'Gamma' },
  { provider: 'other', id: 'delta', name: 'Delta' },
  { provider: 'other', id: 'epsilon', name: 'Epsilon' }
]

const RPC_ORDER = ['test/alpha', 'test/beta', 'test/gamma', 'other/delta', 'other/epsilon']
const ENABLED_ORDER = ['test/gamma', 'other/epsilon']
const EXPECTED_ORDER = ['test/gamma', 'other/epsilon', 'test/alpha', 'test/beta', 'other/delta']

class FakeSessions {
  constructor(private readonly session: any) {}

  async create() {
    return this.session
  }

  maybeGet(sessionId: string) {
    return sessionId === this.session.sessionId ? this.session : undefined
  }

  close() {}
}

async function withSettings<T>(
  globalSettings: Record<string, unknown>,
  projectSettings: Record<string, unknown> | null,
  operation: (cwd: string) => Promise<T>
): Promise<T> {
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-acp-models-'))
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(globalSettings), 'utf-8')

  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-models-cwd-'))
  if (projectSettings) {
    mkdirSync(join(cwd, '.pi'), { recursive: true })
    writeFileSync(join(cwd, '.pi', 'settings.json'), JSON.stringify(projectSettings), 'utf-8')
  }

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  const realSetTimeout = globalThis.setTimeout
  ;(globalThis as any).setTimeout = () => 0 as any

  try {
    return await operation(cwd)
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    ;(globalThis as any).setTimeout = realSetTimeout
  }
}

function makeSession(cwd: string) {
  const state = {
    thinkingLevel: 'high',
    model: { provider: 'test', id: 'alpha' }
  }
  const proc = {
    async getAvailableThinkingLevels() {
      return ['high']
    },
    async getAvailableModels() {
      return { models: MODELS }
    },
    async getState() {
      return state
    },
    async getCommands() {
      return { commands: [] }
    },
    async getMessages() {
      return { messages: [] }
    },
    async setModel(provider: string, id: string) {
      state.model = { provider, id }
    },
    async setThinkingLevel(level: string) {
      state.thinkingLevel = level
    }
  }

  return {
    sessionId: 's1',
    cwd,
    proc,
    setStartupInfo() {},
    sendStartupInfoIfPending() {},
    async publishContextUsage() {}
  }
}

function advertisedModelIds(result: any): string[] {
  return result.models?.availableModels.map((model: { modelId: string }) => model.modelId) ?? []
}

function configModelIds(configOptions: any[] | null | undefined): string[] {
  return (
    configOptions?.find(option => option.id === 'model')?.options.map((option: { value: string }) => option.value) ?? []
  )
}

test('advertises models in Pi RPC order when enabledModels is not configured', async () => {
  await withSettings({}, null, async cwd => {
    const conn = new FakeAgentSideConnection()
    const session = makeSession(cwd)
    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FakeSessions(session) as any

    const result = await agent.newSession({ cwd, mcpServers: [] } as any)
    assert.deepEqual(advertisedModelIds(result), RPC_ORDER)
  })
})

test('global enabledModels order is shared across projects and keeps every unmatched model in Pi order', async () => {
  const firstProject = await withSettings(
    { enabledModels: ENABLED_ORDER },
    { enabledModels: ['other/delta', 'test/beta'] },
    async cwd => {
      const conn = new FakeAgentSideConnection()
      const session = makeSession(cwd)
      const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
      ;(agent as any).sessions = new FakeSessions(session) as any
      const result = await agent.newSession({ cwd, mcpServers: [] } as any)
      return advertisedModelIds(result)
    }
  )
  const secondProject = await withSettings(
    { enabledModels: ENABLED_ORDER },
    { enabledModels: ['test/alpha', 'other/delta', 'test/beta'] },
    async cwd => {
      const conn = new FakeAgentSideConnection()
      const session = makeSession(cwd)
      const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
      ;(agent as any).sessions = new FakeSessions(session) as any
      const result = await agent.newSession({ cwd, mcpServers: [] } as any)
      return advertisedModelIds(result)
    }
  )

  assert.deepEqual(firstProject, EXPECTED_ORDER)
  assert.deepEqual(secondProject, EXPECTED_ORDER)
})

test('loadSession applies global enabledModels order to models and config options', async () => {
  await withSettings({ enabledModels: ENABLED_ORDER }, { enabledModels: ['other/delta', 'test/beta'] }, async cwd => {
    const conn = new FakeAgentSideConnection()
    const session = makeSession(cwd)
    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FakeSessions(session) as any
    ;(agent as any).store = { upsert() {} }
    ;(agent as any).findStoredSession = () => ({ cwd, sessionFile: '/tmp/session.jsonl' })
    ;(agent as any).restoreSession = async () => session

    const result = await agent.loadSession({ sessionId: 's1', cwd, mcpServers: [] } as any)
    assert.deepEqual(advertisedModelIds(result), EXPECTED_ORDER)
    assert.deepEqual(configModelIds(result.configOptions), EXPECTED_ORDER)
  })
})

test('model and mode config updates regenerate options in global enabledModels order', async () => {
  await withSettings({ enabledModels: ENABLED_ORDER }, { enabledModels: ['other/delta', 'test/beta'] }, async cwd => {
    const conn = new FakeAgentSideConnection()
    const session = makeSession(cwd)
    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FakeSessions(session) as any

    const modelResult = await agent.setSessionConfigOption({
      sessionId: 's1',
      configId: 'model',
      value: 'test/beta'
    } as any)
    assert.deepEqual(configModelIds(modelResult.configOptions), EXPECTED_ORDER)

    await agent.setSessionMode({ sessionId: 's1', modeId: 'high' } as any)
    const lastConfigUpdate = conn.updates
      .filter(update => update.update.sessionUpdate === 'config_option_update')
      .at(-1)
    assert.ok(lastConfigUpdate && lastConfigUpdate.update.sessionUpdate === 'config_option_update')
    assert.deepEqual(configModelIds(lastConfigUpdate.update.configOptions), EXPECTED_ORDER)
  })
})
