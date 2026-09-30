import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ENV_NAME = 'PI_ACP_MCP_SERVERS'

type PiExtensionApi = {
  registerMcpServer?(name: string, config: Record<string, unknown>): void
  on(
    event: 'session_start',
    listener: (event: unknown, ctx?: { isProjectTrusted?(): boolean }) => void | Promise<void>
  ): void
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readDefinitions(): Record<string, Record<string, unknown>> {
  const encoded = process.env[ENV_NAME]
  if (!encoded) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    throw new Error('could not decode supplied ACP MCP servers')
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('supplied ACP MCP servers must be an object')
  for (const [name, definition] of Object.entries(parsed)) {
    if (!definition || typeof definition !== 'object' || Array.isArray(definition))
      throw new Error(`server ${JSON.stringify(name)} must be an object`)
  }
  return parsed as Record<string, Record<string, unknown>>
}

function agentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR
  if (!configured) return join(homedir(), '.pi', 'agent')
  if (configured === '~') return homedir()
  if (configured.startsWith('~/') || (process.platform === 'win32' && configured.startsWith('~\\')))
    return join(homedir(), configured.slice(2))
  return configured
}

/**
 * Names of the entries Pi would load from an `mcp.json`. Pi skips entries it
 * cannot connect, so only an object with a `command`, or a `url` on a
 * transport other than legacy SSE, counts; `enabled: false` still counts.
 */
function configuredServerNames(path: string): Set<string> {
  let servers: unknown
  try {
    servers = (JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: unknown }).mcpServers
  } catch {
    return new Set()
  }
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return new Set()
  const names = new Set<string>()
  for (const [name, entry] of Object.entries(servers)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const { command, url, type } = entry as Record<string, unknown>
    const connectable =
      (typeof command === 'string' && command !== '') || (typeof url === 'string' && url !== '' && type !== 'sse')
    if (connectable) names.add(name)
  }
  return names
}

/**
 * Pi's `mcp.json` entries take precedence over extension registrations with the
 * same name, even disabled ones, and Pi drops the registration without an
 * error. Name the file so the collision is reported instead of silently
 * replacing the session server. Pi reads the project file only once the
 * project is trusted.
 */
function configuredShadow(name: string, projectTrusted: boolean): string | undefined {
  const global = join(agentDir(), 'mcp.json')
  if (configuredServerNames(global).has(name)) return `Pi uses the same-named entry in ${global} instead`
  if (!projectTrusted) return undefined
  const project = join(process.cwd(), '.pi', 'mcp.json')
  if (configuredServerNames(project).has(name)) return `Pi uses the same-named entry in ${project} instead`
  return undefined
}

/**
 * This extension intentionally does not implement MCP. It hands standard ACP
 * session-scoped definitions from pi-acp to Pi's built-in MCP support through
 * `pi.registerMcpServer()`, without writing MCP configuration files.
 *
 * Registration happens while the extension loads, so the servers connect at
 * session start together with configured ones. Session MCP servers are best
 * effort: a factory that throws is discarded with everything it registered, so
 * failures are collected here and reported from `session_start`, which the
 * host turns into a logged warning while the session keeps working. The
 * configuration collision check also runs there, where project trust is known.
 */
export default function acpMcpBridge(pi: PiExtensionApi): void {
  let definitions: Record<string, Record<string, unknown>>
  try {
    definitions = readDefinitions()
  } catch (error) {
    const message = `pi-acp MCP bridge: could not read session MCP servers (${describeError(error)}). The session continues without them.`
    pi.on('session_start', () => {
      throw new Error(message)
    })
    return
  }

  const names = Object.keys(definitions)
  if (names.length === 0) return

  const failures = new Map<string, string>()
  for (const [name, definition] of Object.entries(definitions)) {
    try {
      if (typeof pi.registerMcpServer !== 'function')
        throw new Error('this Pi version has no built-in MCP support (pi.registerMcpServer); upgrade Pi')
      pi.registerMcpServer(name, definition)
    } catch (error) {
      failures.set(name, describeError(error))
    }
  }

  pi.on('session_start', (_event, ctx) => {
    const projectTrusted = ctx?.isProjectTrusted?.() ?? false
    const reasons = names.flatMap(name => {
      const reason = failures.get(name) ?? configuredShadow(name, projectTrusted)
      return reason === undefined ? [] : [`${name}: ${reason}`]
    })
    if (reasons.length === 0) return
    throw new Error(
      `pi-acp MCP bridge: ${reasons.length} of ${names.length} session MCP server(s) did not attach (${reasons.join('; ')}). The session continues without them.`
    )
  })
}
