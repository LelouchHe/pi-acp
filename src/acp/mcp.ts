import type { McpServer } from '@agentclientprotocol/sdk'

export type PiMcpServerDefinition = {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  httpTransport?: 'sse'
}

export type PiMcpServerDefinitions = Record<string, PiMcpServerDefinition>

function invalid(message: string): never {
  throw new Error(`Invalid ACP MCP server: ${message}`)
}

function requireName(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') invalid('name must be a non-empty string')
  if (value === '__proto__' || value === 'constructor' || value === 'prototype')
    invalid(`unsupported server name ${JSON.stringify(value)}`)
  return value
}

function defineString(target: Record<string, string>, key: string, value: string): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true })
}

function toEnvironment(entries: unknown): Record<string, string> {
  if (!Array.isArray(entries)) invalid('stdio env must be an array')
  const env: Record<string, string> = {}
  for (const entry of entries) {
    const value = entry as { name?: unknown; value?: unknown }
    if (typeof value.name !== 'string' || value.name === '')
      invalid('environment variable name must be a non-empty string')
    if (value.name.includes('\0')) invalid(`environment variable ${JSON.stringify(value.name)} contains a NUL byte`)
    if (typeof value.value !== 'string')
      invalid(`environment variable ${JSON.stringify(value.name)} value must be a string`)
    if (Object.hasOwn(env, value.name)) invalid(`duplicate environment variable ${JSON.stringify(value.name)}`)
    defineString(env, value.name, value.value)
  }
  return env
}

function toHeaders(entries: unknown): Record<string, string> {
  if (!Array.isArray(entries)) invalid('HTTP headers must be an array')
  const headers: Record<string, string> = {}
  const names = new Set<string>()
  for (const entry of entries) {
    const value = entry as { name?: unknown; value?: unknown }
    if (typeof value.name !== 'string' || value.name.trim() === '')
      invalid('HTTP header name must be a non-empty string')
    if (typeof value.value !== 'string') invalid(`HTTP header ${JSON.stringify(value.name)} value must be a string`)
    const normalized = value.name.toLowerCase()
    if (names.has(normalized)) invalid(`duplicate HTTP header ${JSON.stringify(value.name)}`)
    names.add(normalized)
    defineString(headers, value.name, value.value)
  }
  return headers
}

/**
 * Translate the standard ACP session setup surface to pi-mcp-adapter's
 * runtime-registration shape. This is intentionally process-local and does
 * not read or write any MCP configuration files.
 */
export function translateAcpMcpServers(mcpServers: readonly McpServer[]): PiMcpServerDefinitions {
  const definitions: PiMcpServerDefinitions = {}

  for (const server of mcpServers) {
    const value = server as unknown as Record<string, unknown>
    const name = requireName(value.name)
    if (Object.hasOwn(definitions, name)) invalid(`duplicate MCP server name ${JSON.stringify(name)}`)

    if (value.type === undefined) {
      if (typeof value.command !== 'string' || value.command === '')
        invalid(`stdio server ${JSON.stringify(name)} command must be a non-empty string`)
      if (!Array.isArray(value.args) || !value.args.every(arg => typeof arg === 'string'))
        invalid(`stdio server ${JSON.stringify(name)} args must be an array of strings`)
      definitions[name] = {
        command: value.command,
        args: [...value.args] as string[],
        env: toEnvironment(value.env)
      }
      continue
    }

    if (value.type === 'acp') invalid('ACP MCP transport is not supported by pi')
    if (value.type !== 'http' && value.type !== 'sse') invalid(`unsupported transport ${JSON.stringify(value.type)}`)
    if (typeof value.url !== 'string' || value.url === '')
      invalid(`${value.type} server ${JSON.stringify(name)} url must be a non-empty string`)

    definitions[name] = {
      url: value.url,
      headers: toHeaders(value.headers),
      ...(value.type === 'sse' ? { httpTransport: 'sse' as const } : {})
    }
  }

  return definitions
}
