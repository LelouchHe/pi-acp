import type { McpServer } from '@agentclientprotocol/sdk'

export type PiMcpExposure = 'direct' | 'codemode' | 'codemode-deferred' | 'deferred' | 'hidden'

/** One `mcpServers` entry in the shape Pi's built-in MCP support accepts. */
export type PiMcpServerDefinition = {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  exposure?: PiMcpExposure
  toolExposure?: Record<string, PiMcpExposure>
}

export type PiMcpServerDefinitions = Record<string, PiMcpServerDefinition>

function invalid(message: string): never {
  throw new Error(`Invalid ACP MCP server: ${message}`)
}

const SERVER_NAME = /^[A-Za-z0-9_-]+$/

function requireName(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') invalid('name must be a non-empty string')
  if (value === '__proto__' || value === 'constructor' || value === 'prototype')
    invalid(`unsupported server name ${JSON.stringify(value)}`)
  if (!SERVER_NAME.test(value))
    invalid(`server name ${JSON.stringify(value)} may only contain letters, digits, "_" and "-"`)
  return value
}

/**
 * Pi resolves `env` and `headers` values as config references: `$NAME` and
 * `${NAME}` read environment variables and a leading `!` runs a shell command.
 * ACP supplies literal values, so escape them (`$$` is a literal `$`, `$!` a
 * literal `!`) to keep a client-provided value from expanding or executing.
 */
export function escapePiConfigValue(value: string): string {
  const escaped = value.replaceAll('$', '$$$$')
  return escaped.startsWith('!') ? `$${escaped}` : escaped
}

function defineString(target: Record<string, string>, key: string, value: string): void {
  Object.defineProperty(target, key, {
    value: escapePiConfigValue(value),
    enumerable: true,
    configurable: true,
    writable: true
  })
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

type Exposure = Pick<PiMcpServerDefinition, 'exposure' | 'toolExposure'>

/**
 * Map the optional `_meta.directTools` hint to Pi's exposure settings: `true`
 * declares every tool to the model, and a tool-name list declares only those
 * tools while the rest keep Pi's default exposure.
 */
function exposureFromMeta(value: Record<string, unknown>): Exposure {
  const meta = value._meta
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {}

  const directTools = (meta as Record<string, unknown>).directTools
  if (directTools === undefined || directTools === false) return {}
  if (directTools === true) return { exposure: 'direct' }
  if (!Array.isArray(directTools) || !directTools.every(tool => typeof tool === 'string' && tool !== ''))
    invalid('MCP _meta.directTools must be a boolean or array of tool names')
  // Pi reads `*` in toolExposure keys as a wildcard, so a literal tool name must not contain one.
  const wildcard = directTools.find(tool => tool.includes('*'))
  if (wildcard !== undefined) invalid(`MCP _meta.directTools entry ${JSON.stringify(wildcard)} must not contain "*"`)
  if (directTools.length === 0) return {}
  const toolExposure: Record<string, PiMcpExposure> = {}
  for (const tool of directTools) {
    Object.defineProperty(toolExposure, tool, {
      value: 'direct',
      enumerable: true,
      configurable: true,
      writable: true
    })
  }
  return { toolExposure }
}

/**
 * Translate the standard ACP session setup surface to the `mcpServers` shape of
 * Pi's built-in MCP support. This is intentionally process-local and does not
 * read or write any MCP configuration files.
 */

export function translateAcpMcpServers(mcpServers: readonly McpServer[]): PiMcpServerDefinitions {
  const definitions: PiMcpServerDefinitions = {}

  for (const server of mcpServers) {
    const value = server as unknown as Record<string, unknown>
    const name = requireName(value.name)
    if (Object.hasOwn(definitions, name)) invalid(`duplicate MCP server name ${JSON.stringify(name)}`)
    const exposure = exposureFromMeta(value)

    if (value.type === undefined) {
      if (typeof value.command !== 'string' || value.command === '')
        invalid(`stdio server ${JSON.stringify(name)} command must be a non-empty string`)
      if (!Array.isArray(value.args) || !value.args.every(arg => typeof arg === 'string'))
        invalid(`stdio server ${JSON.stringify(name)} args must be an array of strings`)
      definitions[name] = {
        command: value.command,
        args: [...value.args] as string[],
        env: toEnvironment(value.env),
        ...exposure
      }
      continue
    }

    if (value.type === 'acp') invalid('ACP MCP transport is not supported by pi')
    if (value.type === 'sse') invalid('legacy SSE MCP transport is not supported by pi; use streamable HTTP')
    if (value.type !== 'http') invalid(`unsupported transport ${JSON.stringify(value.type)}`)
    if (typeof value.url !== 'string' || value.url === '')
      invalid(`http server ${JSON.stringify(name)} url must be a non-empty string`)

    definitions[name] = {
      url: value.url,
      headers: toHeaders(value.headers),
      ...exposure
    }
  }

  return definitions
}
