import type { PiAcpAgentConfig } from './acp/agent.js'

export function parseAdapterOptions(argv: readonly string[]): Required<PiAcpAgentConfig> {
  return {
    approveProject: argv.includes('--approve'),
    includeExtensionCommands: argv.includes('--extension-commands')
  }
}
