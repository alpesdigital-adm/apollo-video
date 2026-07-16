import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { apolloMcpApiClientFromEnvironment } from '../src/v2/mcp/public-api-client.ts'
import { createApolloMcpServer } from '../src/v2/mcp/server.ts'

try {
  const { server } = await createApolloMcpServer({
    api: apolloMcpApiClientFromEnvironment(),
  })
  await server.connect(new StdioServerTransport())
} catch (error) {
  process.stderr.write(
    `Apollo MCP failed to start: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  )
  process.exitCode = 1
}
