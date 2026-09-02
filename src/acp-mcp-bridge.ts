const ENV_NAME = 'PI_ACP_MCP_SERVERS'
const REGISTER_EVENT = 'pi-mcp-adapter:runtime-register:v1'

type Registration = { dispose(): Promise<void> }
type RuntimeRegistrationRequest = {
  version: 1
  name: string
  definition: Record<string, unknown>
  result?: { ok: true; registration: Registration } | { ok: false; error: Error }
}

type PiExtensionApi = {
  events: { emit(name: string, event: RuntimeRegistrationRequest): void }
  on(event: 'session_start' | 'session_shutdown', listener: () => void | Promise<void>): void
}

function fail(message: string): never {
  throw new Error(`pi-acp MCP bridge: ${message}`)
}

function readDefinitions(): Record<string, Record<string, unknown>> {
  const encoded = process.env[ENV_NAME]
  if (!encoded) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    fail('could not decode supplied ACP MCP servers')
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('supplied ACP MCP servers must be an object')
  for (const [name, definition] of Object.entries(parsed)) {
    if (!definition || typeof definition !== 'object' || Array.isArray(definition))
      fail(`server ${JSON.stringify(name)} must be an object`)
  }
  return parsed as Record<string, Record<string, unknown>>
}

/**
 * This extension intentionally does not implement MCP. It transfers standard
 * ACP session-scoped definitions from pi-acp to an already-loaded
 * pi-mcp-adapter instance without reading or writing MCP configuration files.
 */
export default function acpMcpBridge(pi: PiExtensionApi): void {
  const definitions = readDefinitions()
  const registrations: Registration[] = []

  pi.on('session_start', async () => {
    try {
      for (const [name, definition] of Object.entries(definitions)) {
        const request: RuntimeRegistrationRequest = { version: 1, name, definition }
        pi.events.emit(REGISTER_EVENT, request)
        if (!request.result) fail('pi-mcp-adapter is not installed or enabled')
        if (!request.result.ok) throw request.result.error
        registrations.push(request.result.registration)
      }
    } catch (error) {
      await Promise.all(registrations.splice(0).map(registration => registration.dispose()))
      if (error instanceof Error && error.message.startsWith('pi-acp MCP bridge:')) throw error
      fail(error instanceof Error ? error.message : String(error))
    }
  })

  pi.on('session_shutdown', async () => {
    await Promise.all(registrations.splice(0).map(registration => registration.dispose()))
  })
}
