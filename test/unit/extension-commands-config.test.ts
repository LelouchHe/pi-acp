import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  constructor(private readonly session: any) {}

  async create() {
    return this.session
  }
}

async function advertisedCommandNames(includeExtensionCommands: boolean): Promise<string[]> {
  const projectDir = mkdtempSync(join(tmpdir(), 'pi-acp-extension-commands-'))
  mkdirSync(join(projectDir, '.pi'))
  writeFileSync(join(projectDir, '.pi', 'settings.json'), JSON.stringify({ quietStartup: true }))

  const scheduled: Array<() => void> = []
  const realSetTimeout = globalThis.setTimeout
  ;(globalThis as any).setTimeout = (fn: () => void) => {
    scheduled.push(fn)
    return 0 as any
  }

  try {
    const conn = new FakeAgentSideConnection()
    const session = {
      sessionId: 's1',
      proc: {
        async getAvailableModels() {
          return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
        },
        async getState() {
          return { thinkingLevel: 'medium', model: { provider: 'test', id: 'model' } }
        },
        async getCommands() {
          return { commands: [{ name: 'analytics', description: 'Usage analytics', source: 'extension' }] }
        }
      },
      sendUsageUpdate() {},
      setStartupInfo() {},
      sendStartupInfoIfPending() {}
    }

    const agent = new PiAcpAgent(asAgentConn(conn), { includeExtensionCommands })
    ;(agent as any).sessions = new FakeSessions(session) as any

    await agent.newSession({ cwd: projectDir, mcpServers: [] } as any)
    for (const callback of scheduled) callback()
    await new Promise<void>(resolve => setImmediate(resolve))

    const commandUpdate = conn.updates.find(update => update.update.sessionUpdate === 'available_commands_update')
    const commands = (commandUpdate?.update as any)?.availableCommands ?? []
    return commands.map((command: any) => command.name)
  } finally {
    ;(globalThis as any).setTimeout = realSetTimeout
    rmSync(projectDir, { recursive: true, force: true })
  }
}

test('PiAcpAgent hides extension commands by default', async () => {
  assert.equal((await advertisedCommandNames(false)).includes('analytics'), false)
})

test('PiAcpAgent advertises extension commands when enabled', async () => {
  assert.equal((await advertisedCommandNames(true)).includes('analytics'), true)
})
