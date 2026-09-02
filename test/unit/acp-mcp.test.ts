import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentSideConnection, ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'
import { translateAcpMcpServers } from '../../src/acp/mcp.js'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test('translateAcpMcpServers translates standard stdio, HTTP, and SSE servers', () => {
  const translated = translateAcpMcpServers([
    {
      name: 'stdio-tools',
      command: 'node',
      args: ['server.mjs'],
      env: [{ name: 'TOKEN', value: 'secret' }]
    },
    {
      type: 'http',
      name: 'remote-tools',
      url: 'https://example.test/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer token' }],
      _meta: { directTools: true }
    },
    {
      type: 'sse',
      name: 'legacy-tools',
      url: 'https://example.test/sse',
      headers: []
    }
  ] as any)

  assert.deepEqual(translated, {
    'stdio-tools': {
      command: 'node',
      args: ['server.mjs'],
      env: { TOKEN: 'secret' }
    },
    'remote-tools': {
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer token' },
      directTools: true
    },
    'legacy-tools': {
      url: 'https://example.test/sse',
      headers: {},
      httpTransport: 'sse'
    }
  })
})

test('PiAcpAgent advertises and forwards standard ACP MCP servers to a Pi subprocess', async () => {
  const originalSpawn = PiRpcProcess.spawn
  const spawnCalls: unknown[] = []
  ;(PiRpcProcess as any).spawn = async (params: unknown) => {
    spawnCalls.push(params)
    return {
      onEvent: () => () => {},
      async getState() {
        return { sessionId: 'mcp-session' }
      },
      async getAvailableModels() {
        return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
      },
      async getSessionStats() {
        return {}
      },
      dispose() {}
    }
  }

  try {
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
    const initialized = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} } as any)
    assert.deepEqual(initialized.agentCapabilities?.mcpCapabilities, { http: true, sse: true })

    await agent.newSession({
      cwd: '/tmp/project',
      mcpServers: [
        {
          type: 'http',
          name: 'remote-tools',
          url: 'https://example.test/mcp',
          headers: [{ name: 'Authorization', value: 'Bearer token' }],
          _meta: { directTools: ['echo'] }
        }
      ]
    } as any)

    assert.deepEqual(spawnCalls, [
      {
        cwd: '/tmp/project',
        piCommand: process.env.PI_ACP_PI_COMMAND,
        mcpServers: {
          'remote-tools': {
            url: 'https://example.test/mcp',
            headers: { Authorization: 'Bearer token' },
            directTools: ['echo']
          }
        }
      }
    ])
    agent.dispose()
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('AgentSideConnection preserves _meta directTools through real session/new parsing', async () => {
  const originalSpawn = PiRpcProcess.spawn
  const spawnCalls: unknown[] = []
  ;(PiRpcProcess as any).spawn = async (params: unknown) => {
    spawnCalls.push(params)
    return {
      onEvent: () => () => {},
      async getState() {
        return { sessionId: 'meta-session' }
      },
      async getAvailableModels() {
        return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
      },
      async getSessionStats() {
        return {}
      },
      dispose() {}
    }
  }

  const clientToAgent = new TransformStream()
  const agentToClient = new TransformStream()
  const agentConnection = new AgentSideConnection(
    conn => new PiAcpAgent(conn),
    ndJsonStream(agentToClient.writable, clientToAgent.readable)
  )
  void agentConnection
  const clientConnection = new ClientSideConnection(
    () => ({
      async requestPermission() {
        return { outcome: { outcome: 'cancelled' } }
      },
      async sessionUpdate() {}
    }) as any,
    ndJsonStream(clientToAgent.writable, agentToClient.readable)
  )

  try {
    await clientConnection.newSession({
      cwd: '/tmp/project',
      mcpServers: [
        {
          type: 'http',
          name: 'webagent-task',
          url: 'http://127.0.0.1:6800/mcp',
          headers: [{ name: 'Authorization', value: 'Bearer token' }],
          directTools: false,
          _meta: { directTools: true }
        }
      ]
    } as any)
    assert.deepEqual(spawnCalls[0], {
      cwd: '/tmp/project',
      piCommand: process.env.PI_ACP_PI_COMMAND,
      mcpServers: {
        'webagent-task': {
          url: 'http://127.0.0.1:6800/mcp',
          headers: { Authorization: 'Bearer token' },
          directTools: true
        }
      }
    })
  } finally {
    ;(PiRpcProcess as any).spawn = originalSpawn
  }
})

test('translateAcpMcpServers rejects unsupported ACP transport and ambiguous definitions', () => {
  assert.throws(
    () => translateAcpMcpServers([{ type: 'acp', name: 'nested', id: 'opaque-id' }] as any),
    /ACP MCP transport is not supported/
  )
  assert.throws(
    () =>
      translateAcpMcpServers([
        { type: 'http', name: 'one', url: 'https://example.test/mcp', headers: [] },
        { type: 'http', name: 'one', url: 'https://example.test/other', headers: [] }
      ] as any),
    /duplicate MCP server name/
  )
  assert.throws(
    () =>
      translateAcpMcpServers([
        {
          type: 'http',
          name: 'headers',
          url: 'https://example.test/mcp',
          headers: [
            { name: 'Authorization', value: 'first' },
            { name: 'authorization', value: 'second' }
          ]
        }
      ] as any),
    /duplicate HTTP header/
  )
})
