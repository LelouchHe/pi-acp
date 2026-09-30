import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, copyFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { translateAcpMcpServers } from '../../src/acp/mcp.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

// Runs only against a real Pi with built-in MCP support (>= 0.99), named by
// PI_ACP_REAL_PI, for example: PI_ACP_REAL_PI=$(command -v pi) npm test
const realPi = process.env.PI_ACP_REAL_PI
const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url))
const fixtureServer = join(fixtures, 'mcp-fixture-server.mjs')

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

async function waitFor<T>(read: () => T | undefined, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${what}`)
}

test(
  'session MCP servers reach Pi built-in MCP with ACP exposure hints and literal values',
  { skip: !realPi },
  async t => {
    const root = mkdtempSync(join(tmpdir(), 'pi-acp-builtin-mcp-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const agentDir = join(root, 'agent')
    mkdirSync(join(agentDir, 'extensions'), { recursive: true })
    copyFileSync(join(fixtures, 'mcp-probe-extension.mjs'), join(agentDir, 'extensions', 'mcp-probe.js'))
    // Pi refuses prompts, even extension commands, without a usable model. This
    // placeholder is never called: the probe command does not reach the model.
    writeFileSync(
      join(agentDir, 'models.json'),
      JSON.stringify({
        providers: {
          placeholder: {
            baseUrl: 'http://127.0.0.1:9/v1',
            api: 'openai-completions',
            apiKey: 'unused',
            models: [{ id: 'unused' }]
          }
        }
      })
    )
    writeFileSync(
      join(agentDir, 'settings.json'),
      JSON.stringify({ defaultProvider: 'placeholder', defaultModel: 'unused' })
    )
    const report = join(root, 'report.jsonl')
    const probeOut = join(root, 'probe.json')

    const port = await freePort()
    const http = spawn(process.execPath, [fixtureServer, 'http', String(port), report], {
      stdio: ['ignore', 'pipe', 'inherit']
    })
    t.after(() => http.kill())
    await new Promise<void>((resolve, reject) => {
      http.stdout.once('data', () => resolve())
      http.once('exit', code => reject(new Error(`fixture HTTP server exited with ${code}`)))
    })

    const mcpServers = translateAcpMcpServers([
      {
        type: 'http',
        name: 'remote',
        url: `http://127.0.0.1:${port}/mcp`,
        headers: [{ name: 'Authorization', value: 'Bearer $TOKEN!${HOME}' }],
        _meta: { directTools: true }
      },
      {
        name: 'local',
        command: process.execPath,
        args: [fixtureServer, 'stdio'],
        env: [
          { name: 'REPORT_FILE', value: report },
          { name: 'LITERAL_COMMAND', value: '!echo executed' },
          { name: 'LITERAL_VAR', value: '${HOME}' }
        ],
        _meta: { directTools: ['echo'] }
      }
    ] as any)

    const previousEnv = { ...process.env }
    Object.assign(process.env, {
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: '1',
      PI_SKIP_VERSION_CHECK: '1',
      PROBE_OUT: probeOut,
      PROBE_EXPECTED_TOOLS: '4'
    })
    let proc: PiRpcProcess
    try {
      proc = await PiRpcProcess.spawn({ cwd: root, piCommand: realPi, mcpServers })
    } finally {
      for (const key of [
        'PI_CODING_AGENT_DIR',
        'PI_OFFLINE',
        'PI_SKIP_VERSION_CHECK',
        'PROBE_OUT',
        'PROBE_EXPECTED_TOOLS'
      ])
        if (previousEnv[key] === undefined) delete process.env[key]
        else process.env[key] = previousEnv[key]
    }
    t.after(() => proc.dispose())

    await proc.prompt('/mcp-probe')
    const probe = await waitFor(
      () => (existsSync(probeOut) ? JSON.parse(readFileSync(probeOut, 'utf8')) : undefined),
      'the probe report'
    )

    const exposures = Object.fromEntries(
      (probe.tools as Array<{ name: string; exposure: string }>).map(tool => [tool.name, tool.exposure])
    )
    assert.deepEqual(exposures, {
      mcp__remote__echo: 'direct',
      mcp__remote__other: 'direct',
      mcp__local__echo: 'direct',
      mcp__local__other: 'codemode'
    })
    for (const name of ['mcp__remote__echo', 'mcp__remote__other', 'mcp__local__echo'])
      assert.ok(probe.active.includes(name), `${name} should be declared to the model`)
    assert.equal(probe.active.includes('mcp__local__other'), false)

    const entries = readFileSync(report, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    assert.deepEqual(entries.find(entry => entry.mode === 'stdio')?.env, {
      LITERAL_COMMAND: '!echo executed',
      LITERAL_VAR: '${HOME}'
    })
    const authorizations = new Set(entries.filter(entry => entry.mode === 'http').map(entry => entry.authorization))
    assert.deepEqual([...authorizations], ['Bearer $TOKEN!${HOME}'])
  }
)
