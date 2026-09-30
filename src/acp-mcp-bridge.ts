const ENV_NAME = 'PI_ACP_MCP_SERVERS'

type PiExtensionApi = {
  registerMcpServer?(name: string, config: Record<string, unknown>): void
  on(event: 'session_start', listener: () => void | Promise<void>): void
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

/**
 * This extension intentionally does not implement MCP. It hands standard ACP
 * session-scoped definitions from pi-acp to Pi's built-in MCP support through
 * `pi.registerMcpServer()`, without reading or writing MCP configuration files.
 *
 * Registration happens while the extension loads, so the servers connect at
 * session start together with configured ones. Session MCP servers are best
 * effort: a factory that throws is discarded with everything it registered, so
 * failures are collected here and reported from `session_start`, which the
 * host turns into a logged warning while the session keeps working.
 */
export default function acpMcpBridge(pi: PiExtensionApi): void {
  let report: string | undefined

  try {
    const definitions = readDefinitions()
    const names = Object.keys(definitions)
    const failures: string[] = []
    for (const [name, definition] of Object.entries(definitions)) {
      try {
        if (typeof pi.registerMcpServer !== 'function')
          throw new Error('this Pi version has no built-in MCP support (pi.registerMcpServer); upgrade Pi')
        pi.registerMcpServer(name, definition)
      } catch (error) {
        failures.push(`${name}: ${describeError(error)}`)
      }
    }
    if (failures.length > 0)
      report = `${failures.length} of ${names.length} session MCP server(s) did not attach (${failures.join('; ')})`
  } catch (error) {
    report = `could not read session MCP servers (${describeError(error)})`
  }

  if (report === undefined) return
  const message = `pi-acp MCP bridge: ${report}. The session continues without them.`
  pi.on('session_start', () => {
    throw new Error(message)
  })
}
