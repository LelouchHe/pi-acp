#!/usr/bin/env node
// Minimal MCP server for the real-Pi integration test. `stdio` mode speaks
// newline-delimited JSON-RPC on stdin/stdout; `http` mode serves streamable
// HTTP with JSON responses on the port given as the second argument. Both
// append what Pi supplied (stdio environment, HTTP headers) to REPORT_FILE.
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'

const [mode, port] = process.argv.slice(2)
const report = process.env.REPORT_FILE ?? process.argv[4]

function record(entry) {
  if (report) appendFileSync(report, JSON.stringify(entry) + '\n')
}

const tools = [
  {
    name: 'echo',
    description: 'Echo text back.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } }
  },
  { name: 'other', description: 'Another tool.', inputSchema: { type: 'object', properties: {} } }
]

function handle(message) {
  if (message.id === undefined) return undefined
  switch (message.method) {
    case 'initialize':
      return {
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '1.0.0' }
      }
    case 'tools/list':
      return { tools }
    case 'tools/call':
      return { content: [{ type: 'text', text: String(message.params?.arguments?.text ?? '') }] }
    case 'ping':
      return {}
    default:
      return { error: { code: -32601, message: `unsupported ${message.method}` } }
  }
}

function reply(message) {
  const result = handle(message)
  if (result === undefined) return undefined
  if (result.error) return { jsonrpc: '2.0', id: message.id, error: result.error }
  return { jsonrpc: '2.0', id: message.id, result }
}

if (mode === 'stdio') {
  record({ mode, env: { LITERAL_COMMAND: process.env.LITERAL_COMMAND, LITERAL_VAR: process.env.LITERAL_VAR } })
  let buffer = ''
  process.stdin.on('data', chunk => {
    buffer += chunk.toString()
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      const response = reply(JSON.parse(line))
      if (response) process.stdout.write(JSON.stringify(response) + '\n')
    }
  })
  process.stdin.on('end', () => process.exit(0))
} else {
  const server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      record({ mode: 'http', authorization: req.headers.authorization })
      const response = reply(JSON.parse(body))
      if (!response) {
        res.writeHead(202).end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(response))
    })
  })
  server.listen(Number(port), '127.0.0.1', () => process.stdout.write('listening\n'))
}
