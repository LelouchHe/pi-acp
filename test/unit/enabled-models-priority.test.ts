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

class FakeSessions {
  constructor(private readonly session: any) {}

  async create() {
    return this.session
  }

  close() {}
}

async function advertisedModelIds(
  globalSettings: Record<string, unknown>,
  projectSettings: Record<string, unknown> | null
): Promise<string[]> {
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-acp-models-'))
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(globalSettings), 'utf-8')

  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-models-cwd-'))
  if (projectSettings) {
    mkdirSync(join(cwd, '.pi'), { recursive: true })
    writeFileSync(join(cwd, '.pi', 'settings.json'), JSON.stringify(projectSettings), 'utf-8')
  }

  const prevAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  const realSetTimeout = globalThis.setTimeout
  ;(globalThis as any).setTimeout = () => 0 as any

  try {
    const conn = new FakeAgentSideConnection()
    const session = {
      sessionId: 's1',
      cwd,
      proc: {
        async getAvailableThinkingLevels() {
          return ['high']
        },
        async getAvailableModels() {
          return { models: MODELS }
        },
        async getState() {
          return { thinkingLevel: 'high', model: { provider: 'test', id: 'alpha' } }
        },
        async getCommands() {
          return { commands: [] }
        }
      },
      setStartupInfo() {},
      sendStartupInfoIfPending() {},
      async publishContextUsage() {}
    }
    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FakeSessions(session) as any

    const result = await agent.newSession({ cwd, mcpServers: [] } as any)
    return result.models?.availableModels.map((model: { modelId: string }) => model.modelId) ?? []
  } finally {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir
    ;(globalThis as any).setTimeout = realSetTimeout
  }
}

test('advertises models in Pi RPC order when enabledModels is not configured', async () => {
  assert.deepEqual(await advertisedModelIds({}, null), RPC_ORDER)
})

test('ignores global and project enabledModels when advertising Pi models', async () => {
  const modelIds = await advertisedModelIds(
    { enabledModels: ['test/gamma', 'other/epsilon'] },
    { enabledModels: ['other/delta', 'test/beta'] }
  )
  assert.deepEqual(modelIds, RPC_ORDER)
})
