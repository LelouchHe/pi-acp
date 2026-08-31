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

const ORIGINAL_ORDER = [
  'test/alpha',
  'test/beta',
  'test/gamma',
  'other/delta',
  'other/epsilon'
]

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
    if (sessionId !== this.session.sessionId) throw new Error(`Unknown sessionId: ${sessionId}`)
    return this.session
  }
}

function makeSession(cwd: string) {
  return {
    sessionId: 's1',
    cwd,
    proc: {
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
    async sendUsageUpdate() {}
  }
}

/** Boot a PiAcpAgent with given global/project settings and return the advertised model ids. */
async function advertisedModelIds(
  globalSettings: Record<string, unknown>,
  projectSettings: Record<string, unknown> | null
): Promise<string[]> {
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-acp-models-'))
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(globalSettings, null, 2), 'utf-8')

  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-models-cwd-'))
  if (projectSettings) {
    mkdirSync(join(cwd, '.pi'), { recursive: true })
    writeFileSync(join(cwd, '.pi', 'settings.json'), JSON.stringify(projectSettings, null, 2), 'utf-8')
  }

  const prevAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  const realSetTimeout = globalThis.setTimeout
  ;(globalThis as any).setTimeout = () => 0 as any

  try {
    const conn = new FakeAgentSideConnection()
    const session = makeSession(cwd)
    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FakeSessions(session) as any

    const result = await agent.newSession({ cwd, mcpServers: [] } as any)
    return result.models?.availableModels.map((m: { modelId: string }) => m.modelId) ?? []
  } finally {
    process.env.PI_CODING_AGENT_DIR = prevAgentDir
    ;(globalThis as any).setTimeout = realSetTimeout
  }
}

test('无 enabledModels:模型保持 pi 返回的顺序', async () => {
  const modelIds = await advertisedModelIds({}, null)
  assert.deepEqual(modelIds, ORIGINAL_ORDER)
})

test('精确 id 列表:命中项按列表顺序置顶,其余保持原顺序', async () => {
  const modelIds = await advertisedModelIds({ enabledModels: ['test/gamma', 'other/epsilon'] }, null)
  assert.deepEqual(modelIds, ['test/gamma', 'other/epsilon', 'test/alpha', 'test/beta', 'other/delta'])
})

test('glob 通配 "test/*":匹配的 provider 全置顶,未命中保持原顺序', async () => {
  const modelIds = await advertisedModelIds({ enabledModels: ['test/*'] }, null)
  assert.deepEqual(modelIds, ['test/alpha', 'test/beta', 'test/gamma', 'other/delta', 'other/epsilon'])
})

test('条目带 :thinking 后缀:按裸 id 匹配', async () => {
  const modelIds = await advertisedModelIds({ enabledModels: ['other/delta:high'] }, null)
  assert.deepEqual(modelIds, ['other/delta', 'test/alpha', 'test/beta', 'test/gamma', 'other/epsilon'])
})

test('已置顶条目在列表中只出现一次(enabledModels 内重复去重)', async () => {
  const modelIds = await advertisedModelIds({ enabledModels: ['test/*', 'test/alpha'] }, null)
  assert.deepEqual(modelIds, ORIGINAL_ORDER)
})

test('非法 enabledModels:整体非数组回退原顺序;混合数组保留合法条目', async () => {
  // Non-array value: fall back to original order, no crash.
  const asString = await advertisedModelIds({ enabledModels: 'test/alpha' }, null)
  assert.deepEqual(asString, ORIGINAL_ORDER)

  // Array with no valid string entries: same fallback.
  const allJunk = await advertisedModelIds({ enabledModels: [42, null, ''] }, null)
  assert.deepEqual(allJunk, ORIGINAL_ORDER)

  // Mixed array: valid entries still apply.
  const mixed = await advertisedModelIds({ enabledModels: ['test/gamma', 42, null, ''] }, null)
  assert.deepEqual(mixed, ['test/gamma', 'test/alpha', 'test/beta', 'other/delta', 'other/epsilon'])
})

test('project settings 覆盖 global 的 enabledModels', async () => {
  const modelIds = await advertisedModelIds({ enabledModels: ['test/alpha'] }, { enabledModels: ['other/epsilon'] })
  assert.deepEqual(modelIds, ['other/epsilon', 'test/alpha', 'test/beta', 'test/gamma', 'other/delta'])
})