import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPiArgs } from '../../src/pi-rpc/process.js'

test('buildPiArgs leaves project trust to Pi by default', () => {
  assert.deepEqual(buildPiArgs({}), ['--mode', 'rpc', '--no-themes'])
})

test('buildPiArgs forwards the explicit project approval override', () => {
  assert.deepEqual(buildPiArgs({ approveProject: true }), ['--mode', 'rpc', '--no-themes', '--approve'])
})

test('buildPiArgs adds the runtime MCP bridge only for supplied ACP MCP servers', () => {
  assert.deepEqual(buildPiArgs({ mcpBridgePath: '/tmp/acp-mcp-bridge.ts' }), [
    '--mode',
    'rpc',
    '--no-themes',
    '--extension',
    '/tmp/acp-mcp-bridge.ts'
  ])
})

test('buildPiArgs combines approval with session restore', () => {
  assert.deepEqual(buildPiArgs({ approveProject: true, sessionPath: '/tmp/session.jsonl' }), [
    '--mode',
    'rpc',
    '--no-themes',
    '--approve',
    '--session',
    '/tmp/session.jsonl'
  ])
})
