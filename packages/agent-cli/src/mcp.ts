#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createGraphMcpServer } from './mcpServer.js'

await createGraphMcpServer().connect(new StdioServerTransport())
