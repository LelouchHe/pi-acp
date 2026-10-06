import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test('PiAcpAgent: deleteSession removes stored session and session file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-delete-test-'))
  const sessionsDir = join(root, 'sessions', '--tmp--delete-project--')
  const sessionFile = join(sessionsDir, '0000_delete_me.jsonl')
  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(
    sessionFile,
    '{"type":"session","version":3,"id":"sess-del-store","timestamp":"2026-06-16T00:00:00.000Z","cwd":"/tmp/delete-project"}\n',
    'utf-8'
  )

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  const storedSessionId = 'stored-session'
  const storeDeletes: string[] = []

  // Inject a SessionStore that tracks calls.
  ;(agent as any).store = {
    get(sessionId: string) {
      if (sessionId !== storedSessionId) return null
      return { sessionId, cwd: '/tmp/delete-project', sessionFile, updatedAt: new Date().toISOString() }
    },
    delete(sessionId: string) {
      storeDeletes.push(sessionId)
    },
    upsert() {}
  }

  try {
    const response = await agent.deleteSession({ sessionId: storedSessionId } as any)
    assert.deepEqual(response, {})
    assert.deepEqual(storeDeletes, [storedSessionId])
    assert.equal(existsSync(sessionFile), false)
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('PiAcpAgent: deleteSession finds session via pi discovery when SessionStore misses', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-delete-discovery-'))
  const sessionsDir = join(root, 'sessions', '--tmp--delete-discovery--')
  const sessionFile = join(sessionsDir, '0000_pi_discovery.jsonl')
  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'pi-discovered-session',
      timestamp: '2026-06-16T00:00:00.000Z',
      cwd: '/tmp/delete-discovery'
    }) + '\n',
    'utf-8'
  )

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  const storeDeletes: string[] = []

  ;(agent as any).store = {
    get() {
      return null
    },
    delete(sessionId: string) {
      storeDeletes.push(sessionId)
    },
    upsert() {}
  }

  try {
    const response = await agent.deleteSession({ sessionId: 'pi-discovered-session' } as any)
    assert.deepEqual(response, {})
    assert.deepEqual(storeDeletes, ['pi-discovered-session'])
    assert.equal(existsSync(sessionFile), false)
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('PiAcpAgent: deleteSession succeeds idempotently for unknown sessionId', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-delete-unknown-'))
  const sessionsDir = join(root, 'sessions', '--tmp--delete-unknown--')
  mkdirSync(sessionsDir, { recursive: true })

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  // Per ACP session/delete semantics, deleting a non-existent session
  // should succeed idempotently (return {} without error).
  const storeDeletes: string[] = []
  ;(agent as any).store = {
    get() {
      return null
    },
    delete(sessionId: string) {
      storeDeletes.push(sessionId)
    },
    upsert() {}
  }

  try {
    const response = await agent.deleteSession({ sessionId: 'non-existent-session' } as any)
    assert.deepEqual(response, {})
    assert.deepEqual(storeDeletes, [])
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('PiAcpAgent: deleteSession stops a live process before unlinking and clearing storage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-delete-live-'))
  const sessionsDir = join(root, 'sessions', '--tmp--delete-live--')
  const sessionFile = join(sessionsDir, '0000_live.jsonl')
  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(sessionFile, '{}\n', 'utf-8')

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const sessionId = 'live-delete-session'
  const calls: string[] = []
  ;(agent as any).store = {
    get(id: string) {
      return id === sessionId
        ? { sessionId, cwd: '/tmp/delete-live', sessionFile, updatedAt: new Date().toISOString() }
        : null
    },
    delete(id: string) {
      calls.push(`delete:${id}`)
    },
    upsert() {}
  }

  const proc = {
    onEvent() {
      return () => {}
    },
    async terminateAndWait() {
      assert.equal(existsSync(sessionFile), true)
      calls.push('stop')
      return true
    },
    dispose() {
      calls.push('dispose')
    }
  }
  ;(agent as any).sessions.getOrCreate(sessionId, {
    cwd: '/tmp/delete-live',
    mcpServers: {},
    conn: asAgentConn(conn),
    proc
  })

  try {
    const response = await agent.deleteSession({ sessionId } as any)
    assert.deepEqual(response, {})
    assert.deepEqual(calls, ['stop', 'dispose', `delete:${sessionId}`])
    assert.equal(existsSync(sessionFile), false)
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('PiAcpAgent: deleteSession stops runtime session when storage and discovery miss', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-delete-runtime-only-'))
  mkdirSync(join(root, 'sessions'), { recursive: true })
  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const sessionId = 'runtime-only-delete-session'
  let stopCount = 0
  ;(agent as any).store = { get: () => null, delete() {}, upsert() {} }
  ;(agent as any).sessions.getOrCreate(sessionId, {
    cwd: '/tmp/runtime-only',
    mcpServers: {},
    conn: asAgentConn(conn),
    proc: {
      onEvent() {
        return () => {}
      },
      async terminateAndWait() {
        stopCount += 1
        return true
      },
      dispose() {}
    }
  })

  try {
    const response = await agent.deleteSession({ sessionId } as any)
    assert.deepEqual(response, {})
    assert.equal(stopCount, 1)
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('PiAcpAgent: deleteSession warns but succeeds if runtime process cannot be stopped', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-delete-stop-failed-'))
  const sessionsDir = join(root, 'sessions', '--tmp--delete-stop-failed--')
  const sessionFile = join(sessionsDir, '0000_stop_failed.jsonl')
  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(sessionFile, '{}\n', 'utf-8')
  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const sessionId = 'stop-failed-session'
  const warnings: unknown[][] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => warnings.push(args)
  ;(agent as any).store = {
    get: () => ({ sessionId, cwd: '/tmp/stop-failed', sessionFile, updatedAt: new Date().toISOString() }),
    delete() {},
    upsert() {}
  }
  ;(agent as any).sessions.getOrCreate(sessionId, {
    cwd: '/tmp/stop-failed',
    mcpServers: {},
    conn: asAgentConn(conn),
    proc: {
      onEvent() {
        return () => {}
      },
      async terminateAndWait() {
        return false
      },
      dispose() {}
    }
  })

  try {
    const response = await agent.deleteSession({ sessionId } as any)
    assert.deepEqual(response, {})
    assert.equal(warnings.length, 1)
    assert.match(String(warnings[0]?.[0]), /stop.*pi.*process|pi.*process.*stop/i)
    assert.equal(existsSync(sessionFile), false)
  } finally {
    console.warn = originalWarn
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('PiAcpAgent: deleteSession survives missing session file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-delete-missingfile-'))
  const sessionsDir = join(root, 'sessions', '--tmp--delete-missingfile--')
  mkdirSync(sessionsDir, { recursive: true })
  const nonExistentFile = join(sessionsDir, '0000_non_existent.jsonl')

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  const storeDeletes: string[] = []

  ;(agent as any).store = {
    get(sessionId: string) {
      if (sessionId !== 'missing-file-session') return null
      return {
        sessionId,
        cwd: '/tmp/delete-missingfile',
        sessionFile: nonExistentFile,
        updatedAt: new Date().toISOString()
      }
    },
    delete(sessionId: string) {
      storeDeletes.push(sessionId)
    },
    upsert() {}
  }

  try {
    const response = await agent.deleteSession({ sessionId: 'missing-file-session' } as any)
    assert.deepEqual(response, {})
    assert.deepEqual(storeDeletes, ['missing-file-session'])
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})
