import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function waitForFile(path: string, timeoutMs = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return readFileSync(path, 'utf-8').trim()
    } catch {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  throw new Error(`Timed out waiting for file: ${path}`)
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

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

test('PiAcpAgent: deleteSession waits for exit confirmation before unlinking', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-delete-await-exit-'))
  const sessionsDir = join(root, 'sessions', '--tmp--delete-await-exit--')
  const sessionFile = join(sessionsDir, '0000_wait_for_exit.jsonl')
  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(sessionFile, '{}\n', 'utf-8')
  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const sessionId = 'wait-for-exit-session'
  const stopResult = deferred<boolean>()
  let stopCalls = 0
  let deletionSettled = false
  ;(agent as any).store = {
    get: () => ({ sessionId, cwd: '/tmp/delete-await-exit', sessionFile, updatedAt: new Date().toISOString() }),
    delete() {},
    upsert() {}
  }
  ;(agent as any).sessions.getOrCreate(sessionId, {
    cwd: '/tmp/delete-await-exit',
    mcpServers: {},
    conn: asAgentConn(conn),
    proc: {
      onEvent() {
        return () => {}
      },
      terminateAndWait() {
        stopCalls += 1
        return stopResult.promise
      },
      dispose() {}
    }
  })

  const deletion = agent.deleteSession({ sessionId } as any).then(response => {
    deletionSettled = true
    return response
  })

  try {
    await Promise.resolve()
    assert.equal(stopCalls, 1)
    assert.equal(existsSync(sessionFile), true)
    assert.equal(deletionSettled, false)

    stopResult.resolve(true)
    assert.deepEqual(await deletion, {})
    assert.equal(existsSync(sessionFile), false)
  } finally {
    stopResult.resolve(true)
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('PiAcpAgent: load during delete cannot replace the captured runtime session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-delete-load-race-'))
  mkdirSync(join(root, 'sessions'), { recursive: true })
  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const sessionId = 'load-during-delete-session'
  const stopResult = deferred<boolean>()
  let oldDisposeCalls = 0
  let spawnCalls = 0
  let storeUpserts = 0
  const originalSpawn = PiRpcProcess.spawn
  const replacement = new FakePiRpcProcess()
  Object.assign(replacement, { dispose() {}, terminateAndWait: async () => true })
  PiRpcProcess.spawn = async () => {
    spawnCalls += 1
    return replacement as unknown as PiRpcProcess
  }
  ;(agent as any).store = {
    get: () => ({ sessionId, cwd: '/tmp/load-during-delete', sessionFile: '/tmp/no-session-file', updatedAt: '' }),
    delete() {},
    upsert() {
      storeUpserts += 1
    }
  }
  ;(agent as any).sessions.getOrCreate(sessionId, {
    cwd: '/tmp/load-during-delete',
    mcpServers: {},
    conn: asAgentConn(conn),
    proc: {
      onEvent() {
        return () => {}
      },
      terminateAndWait() {
        return stopResult.promise
      },
      dispose() {
        oldDisposeCalls += 1
      }
    }
  })

  let deletion: Promise<unknown> | undefined
  let loading: Promise<string> | undefined
  try {
    deletion = agent.deleteSession({ sessionId } as any)
    await Promise.resolve()
    loading = agent.loadSession({ sessionId, cwd: '/tmp/load-during-delete', mcpServers: [] } as any).then(
      () => 'loaded',
      () => 'rejected'
    )

    const loadOutcome = await loading
    assert.equal(oldDisposeCalls, 0)
    stopResult.resolve(true)
    await deletion

    assert.equal(loadOutcome, 'rejected')
    assert.equal(spawnCalls, 0)
    assert.equal(oldDisposeCalls, 1)
    assert.equal(storeUpserts, 0)
    assert.equal((agent as any).sessions.maybeGet(sessionId), undefined)
  } finally {
    stopResult.resolve(true)
    await Promise.allSettled([...(deletion ? [deletion] : []), ...(loading ? [loading] : [])])
    PiRpcProcess.spawn = originalSpawn
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('PiAcpAgent: delete stops a process from an already in-flight restore without registering it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-delete-restore-race-'))
  mkdirSync(join(root, 'sessions'), { recursive: true })
  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const sessionId = 'restore-during-delete-session'
  const spawnStarted = deferred<void>()
  const spawnedProc = new FakePiRpcProcess()
  const spawnResult = deferred<PiRpcProcess>()
  let stopCalls = 0
  let storeUpserts = 0
  const originalSpawn = PiRpcProcess.spawn
  PiRpcProcess.spawn = async () => {
    spawnStarted.resolve()
    return spawnResult.promise
  }
  Object.assign(spawnedProc, {
    terminateAndWait: async () => {
      stopCalls += 1
      return true
    },
    dispose() {}
  })
  ;(agent as any).store = {
    get: () => ({ sessionId, cwd: '/tmp/restore-during-delete', sessionFile: '/tmp/no-session-file', updatedAt: '' }),
    delete() {},
    upsert() {
      storeUpserts += 1
    }
  }

  let restore: Promise<string> | undefined
  let deletion: Promise<unknown> | undefined
  try {
    restore = (agent as any).restoreSession(sessionId).then(
      () => 'restored',
      () => 'rejected'
    )
    await spawnStarted.promise
    const upsertsBeforeSpawnCompletes = storeUpserts

    deletion = agent.deleteSession({ sessionId } as any)
    spawnResult.resolve(spawnedProc as unknown as PiRpcProcess)
    const deleted = await deletion
    const restoreOutcome = await restore

    assert.deepEqual(deleted, {})
    assert.equal(restoreOutcome, 'rejected')
    assert.equal(stopCalls, 1)
    assert.equal(storeUpserts, upsertsBeforeSpawnCompletes)
    assert.equal((agent as any).sessions.maybeGet(sessionId), undefined)
    await assert.rejects((agent as any).restoreSession(sessionId))
    assert.equal(stopCalls, 1)
  } finally {
    await Promise.allSettled([...(restore ? [restore] : []), ...(deletion ? [deletion] : [])])
    PiRpcProcess.spawn = originalSpawn
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('PiAcpAgent: delete does not await a stalled restore spawn without bound', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-delete-stalled-restore-'))
  mkdirSync(join(root, 'sessions'), { recursive: true })
  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const sessionId = 'stalled-restore-delete-session'
  const spawnStarted = deferred<void>()
  const spawnResult = deferred<PiRpcProcess>()
  const spawnedProc = new FakePiRpcProcess()
  let stopCalls = 0
  let storeUpserts = 0
  let restoreSettled = false
  const originalSpawn = PiRpcProcess.spawn
  PiRpcProcess.spawn = async () => {
    spawnStarted.resolve()
    return spawnResult.promise
  }
  Object.assign(spawnedProc, {
    terminateAndWait: async () => {
      stopCalls += 1
      return true
    },
    dispose() {}
  })
  ;(agent as any).store = {
    get: () => ({ sessionId, cwd: '/tmp/stalled-restore', sessionFile: '/tmp/no-session-file', updatedAt: '' }),
    delete() {},
    upsert() {
      storeUpserts += 1
    }
  }

  let restore: Promise<string> | undefined
  let deletion: Promise<unknown> | undefined
  try {
    const restorePromise = (agent as any).restoreSession(sessionId).then(
      () => 'restored',
      () => 'rejected'
    ) as Promise<string>
    restore = restorePromise
    void restorePromise.then(() => {
      restoreSettled = true
    })
    await spawnStarted.promise

    deletion = agent.deleteSession({ sessionId } as any)
    let timeout: ReturnType<typeof setTimeout> | undefined
    const deleteOutcome = await Promise.race([
      deletion.then(
        response => ({ kind: 'done' as const, response }),
        error => ({ kind: 'rejected' as const, error })
      ),
      new Promise<{ kind: 'timeout' }>(resolve => {
        timeout = setTimeout(() => resolve({ kind: 'timeout' }), 3_500)
      })
    ])
    if (timeout) clearTimeout(timeout)

    assert.equal(deleteOutcome.kind, 'done')
    if (deleteOutcome.kind === 'done') assert.deepEqual(deleteOutcome.response, {})
    assert.equal(restoreSettled, false)

    spawnResult.resolve(spawnedProc as unknown as PiRpcProcess)
    assert.equal(await restorePromise, 'rejected')
    assert.equal(stopCalls, 1)
    assert.equal(storeUpserts, 0)
    assert.equal((agent as any).sessions.maybeGet(sessionId), undefined)
    assert.equal((agent as any).deletedSessionIds.get(sessionId), 'pending')
    await agent.deleteSession({ sessionId } as any)
    assert.equal((agent as any).deletedSessionIds.get(sessionId), 'complete')
  } finally {
    spawnResult.resolve(spawnedProc as unknown as PiRpcProcess)
    await Promise.allSettled([...(restore ? [restore] : []), ...(deletion ? [deletion] : [])])
    PiRpcProcess.spawn = originalSpawn
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('PiAcpAgent: delete resolves the active and queued prompts exactly once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-delete-prompt-race-'))
  mkdirSync(join(root, 'sessions'), { recursive: true })
  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const sessionId = 'prompt-during-delete-session'
  const proc = new FakePiRpcProcess()
  const rpcPrompt = deferred<void>()
  let stopCalls = 0
  let piPromptCalls = 0
  Object.assign(proc, {
    async prompt() {
      piPromptCalls += 1
      await rpcPrompt.promise
    },
    terminateAndWait: async () => {
      stopCalls += 1
      return true
    },
    dispose() {}
  })
  ;(agent as any).store = {
    get: () => ({ sessionId, cwd: '/tmp/prompt-during-delete', sessionFile: '/tmp/no-session-file', updatedAt: '' }),
    delete() {},
    upsert() {}
  }
  const session = (agent as any).sessions.getOrCreate(sessionId, {
    cwd: '/tmp/prompt-during-delete',
    mcpServers: {},
    conn: asAgentConn(conn),
    proc
  })

  const settledCounts = [0, 0]
  const active = agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'active' }] } as any).then(response => {
    settledCounts[0] += 1
    return response.stopReason
  })
  await Promise.resolve()
  const queued = agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'queued' }] } as any).then(response => {
    settledCounts[1] += 1
    return response.stopReason
  })

  try {
    const queueDeadline = Date.now() + 1_000
    let queueWasObservable = false
    while (Date.now() < queueDeadline && !queueWasObservable) {
      queueWasObservable = conn.updates.some(message => {
        const update = message.update
        const meta = update._meta as { piAcp?: { queueDepth?: number } } | undefined
        return update.sessionUpdate === 'session_info_update' && meta?.piAcp?.queueDepth === 1
      })
      if (!queueWasObservable) await new Promise(resolve => setTimeout(resolve, 0))
    }
    assert.equal(queueWasObservable, true)

    await agent.deleteSession({ sessionId } as any)
    session.shutdownForDelete()
    proc.emit({ type: 'agent_settled' })
    rpcPrompt.reject(new Error('late Pi RPC rejection'))
    await assert.rejects(agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'after delete' }] } as any))

    let timeout: ReturnType<typeof setTimeout> | undefined
    const outcomes = await Promise.race([
      Promise.all([active, queued]),
      new Promise<null>(resolve => {
        timeout = setTimeout(() => resolve(null), 100)
      })
    ])
    if (timeout) clearTimeout(timeout)

    assert.deepEqual(outcomes, ['cancelled', 'cancelled'])
    assert.deepEqual(settledCounts, [1, 1])
    assert.equal(stopCalls, 1)
    assert.equal(piPromptCalls, 1)
  } finally {
    session.shutdownForDelete()
    rpcPrompt.reject(new Error('test cleanup'))
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('PiAcpAgent: delete retries cleanup after store discovery fails but still stops runtime', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-delete-retry-discovery-'))
  const sessionsDir = join(root, 'sessions')
  mkdirSync(sessionsDir, { recursive: true })
  const sessionFile = join(sessionsDir, '0000_retry_discovery.jsonl')
  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const sessionId = 'retry-discovery-session'
  let storeGets = 0
  let storeDeletes = 0
  let stopCalls = 0
  const warnings: unknown[][] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => warnings.push(args)
  ;(agent as any).store = {
    get() {
      storeGets += 1
      if (storeGets === 1) throw new Error('transient store lookup failure')
      return { sessionId, cwd: '/tmp/retry-discovery', sessionFile, updatedAt: '' }
    },
    delete() {
      storeDeletes += 1
    },
    upsert() {}
  }
  ;(agent as any).sessions.getOrCreate(sessionId, {
    cwd: '/tmp/retry-discovery',
    mcpServers: {},
    conn: asAgentConn(conn),
    proc: {
      onEvent() {
        return () => {}
      },
      async terminateAndWait() {
        stopCalls += 1
        return true
      },
      dispose() {}
    }
  })

  try {
    await assert.rejects(agent.deleteSession({ sessionId } as any), /transient store lookup failure/)
    assert.equal(stopCalls, 1)
    assert.ok(warnings.some(args => String(args[0]).includes('stored session')))
    writeFileSync(
      sessionFile,
      `${JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: '2026-06-16T00:00:00.000Z', cwd: '/tmp/retry-discovery' })}\n`,
      'utf-8'
    )

    assert.deepEqual(await agent.deleteSession({ sessionId } as any), {})
    assert.equal(storeGets, 2)
    assert.equal(storeDeletes, 2)
    assert.equal(existsSync(sessionFile), false)

    await agent.deleteSession({ sessionId } as any)
    assert.equal(storeGets, 2)
  } finally {
    console.warn = originalWarn
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('PiAcpAgent: failed Pi discovery warns, stops runtime, and can be retried', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-delete-pi-discovery-error-'))
  const sessionsDir = join(root, 'sessions')
  mkdirSync(sessionsDir, { recursive: true })
  const sessionFile = join(sessionsDir, '0000_discovery_retry.jsonl')
  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const sessionId = 'discovery-retry-session'
  let discoveryFails = true
  let storeGets = 0
  let stopCalls = 0
  const warnings: unknown[][] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => warnings.push(args)
  ;(agent as any).discoverPiSession = () => {
    if (discoveryFails) throw new Error('temporary Pi discovery failure')
    return null
  }
  ;(agent as any).store = {
    get() {
      storeGets += 1
      return storeGets === 1 ? null : { sessionId, cwd: '/tmp/discovery-retry', sessionFile, updatedAt: '' }
    },
    delete() {},
    upsert() {}
  }
  ;(agent as any).sessions.getOrCreate(sessionId, {
    cwd: '/tmp/discovery-retry',
    mcpServers: {},
    conn: asAgentConn(conn),
    proc: {
      onEvent() {
        return () => {}
      },
      async terminateAndWait() {
        stopCalls += 1
        return true
      },
      dispose() {}
    }
  })

  try {
    await assert.rejects(agent.deleteSession({ sessionId } as any), /temporary Pi discovery failure/)
    assert.equal(stopCalls, 1)
    assert.ok(warnings.some(args => String(args[0]).includes('discover pi session')))

    discoveryFails = false
    writeFileSync(
      sessionFile,
      `${JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: '2026-06-16T00:00:00.000Z', cwd: '/tmp/discovery-retry' })}\n`,
      'utf-8'
    )
    assert.deepEqual(await agent.deleteSession({ sessionId } as any), {})
    assert.equal(storeGets, 2)
    assert.equal(existsSync(sessionFile), false)
  } finally {
    console.warn = originalWarn
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('PiAcpAgent: an unknown delete does not retain a tombstone', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-delete-no-tombstone-'))
  mkdirSync(join(root, 'sessions'), { recursive: true })
  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).store = { get: () => null, delete() {}, upsert() {} }

  try {
    assert.deepEqual(await agent.deleteSession({ sessionId: 'never-existed' } as any), {})
    assert.equal((agent as any).deletedSessionIds.has('never-existed'), false)
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('PiAcpAgent: delete terminates a real child during a stuck Pi RPC handshake', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-delete-handshake-child-'))
  const sessionsDir = join(root, 'sessions')
  mkdirSync(sessionsDir, { recursive: true })
  const sessionId = 'stuck-handshake-session'
  const sessionFile = join(sessionsDir, '0000_stuck_handshake.jsonl')
  const scriptFile = join(root, 'fake-pi')
  const pidFile = join(root, 'child.pid')
  const signalFile = join(root, 'signals.log')
  writeFileSync(
    sessionFile,
    `${JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: '2026-06-16T00:00:00.000Z', cwd: root })}\n`,
    'utf-8'
  )
  writeFileSync(
    scriptFile,
    '#!/usr/bin/env node\n' +
      "const fs = require('node:fs');\n" +
      "process.on('SIGTERM', () => fs.appendFileSync(process.env.PI_ACP_TEST_SIGNAL_FILE, 'TERM\\n'));\n" +
      'fs.writeFileSync(process.env.PI_ACP_TEST_PID_FILE, String(process.pid));\n' +
      "setInterval(() => fs.appendFileSync(process.env.PI_ACP_TEST_SESSION_FILE, '\\n'), 20);\n" +
      'process.stdin.resume();\n',
    'utf-8'
  )
  chmodSync(scriptFile, 0o755)

  const oldEnv = {
    agentDir: process.env.PI_CODING_AGENT_DIR,
    piCommand: process.env.PI_ACP_PI_COMMAND,
    pidFile: process.env.PI_ACP_TEST_PID_FILE,
    signalFile: process.env.PI_ACP_TEST_SIGNAL_FILE,
    sessionFile: process.env.PI_ACP_TEST_SESSION_FILE
  }
  process.env.PI_CODING_AGENT_DIR = root
  process.env.PI_ACP_PI_COMMAND = scriptFile
  process.env.PI_ACP_TEST_PID_FILE = pidFile
  process.env.PI_ACP_TEST_SIGNAL_FILE = signalFile
  process.env.PI_ACP_TEST_SESSION_FILE = sessionFile

  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).store = {
    get: () => ({ sessionId, cwd: root, sessionFile, updatedAt: '' }),
    delete() {},
    upsert() {}
  }

  let pid: number | undefined
  let restore: Promise<string> | undefined
  let deletion: Promise<unknown> | undefined
  try {
    restore = (agent as any).restoreSession(sessionId).then(
      () => 'restored',
      () => 'rejected'
    )
    pid = Number(await waitForFile(pidFile))
    assert.ok(Number.isInteger(pid) && pid > 0)
    assert.equal(processIsAlive(pid), true)

    const startedAt = Date.now()
    deletion = agent.deleteSession({ sessionId } as any)
    assert.deepEqual(await deletion, {})
    assert.equal(existsSync(signalFile), true, 'delete should send SIGTERM to the handshake child')
    assert.match(readFileSync(signalFile, 'utf-8'), /TERM/)
    assert.equal(processIsAlive(pid), false)
    assert.ok(
      Date.now() - startedAt < 2_300,
      'delete should stop the child rather than wait for the full restore drain'
    )
    assert.equal(existsSync(sessionFile), false)
    assert.equal(await restore, 'rejected')
  } finally {
    if (pid && processIsAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // The process may have exited between the liveness check and kill.
      }
    }
    await Promise.allSettled([...(restore ? [restore] : []), ...(deletion ? [deletion] : [])])
    process.env.PI_CODING_AGENT_DIR = oldEnv.agentDir
    process.env.PI_ACP_PI_COMMAND = oldEnv.piCommand
    process.env.PI_ACP_TEST_PID_FILE = oldEnv.pidFile
    process.env.PI_ACP_TEST_SIGNAL_FILE = oldEnv.signalFile
    process.env.PI_ACP_TEST_SESSION_FILE = oldEnv.sessionFile
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
