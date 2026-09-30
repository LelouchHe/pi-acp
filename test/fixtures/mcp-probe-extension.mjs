// Probe extension for the real-Pi integration test. `/mcp-probe` waits for
// session MCP tools to appear, then writes the tool surface to PROBE_OUT.
import { writeFileSync } from 'node:fs'

export default function mcpProbe(pi) {
  pi.registerCommand('mcp-probe', {
    description: 'Report MCP tools for pi-acp tests',
    async handler() {
      const expected = Number(process.env.PROBE_EXPECTED_TOOLS ?? '0')
      const deadline = Date.now() + 15_000
      let tools = []
      while (Date.now() < deadline) {
        tools = pi.getAllTools().filter(tool => tool.name.startsWith('mcp__'))
        if (tools.length >= expected) break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      writeFileSync(
        process.env.PROBE_OUT,
        JSON.stringify({
          active: pi.getActiveTools(),
          tools: tools.map(tool => ({ name: tool.name, exposure: tool.exposure }))
        })
      )
    }
  })
}
