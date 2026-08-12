#!/usr/bin/env node
/* eslint-disable no-console -- stdio MCP startup diagnostics belong on stderr. */

import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { createRelayMcpServer } from '../shared/relay-mcp.js';

// This executable is deliberately configuration-free: Relay URL and credentials
// come only from RELAY_IDE_URL/PORT and RELAY_IDE_ACTOR_TOKEN or BROWSER_TOKEN.
if (process.argv.length !== 2) {
  console.error(
    'relay-mcp accepts no command-line arguments; configure Relay through environment variables.'
  );
  process.exitCode = 64;
} else {
  try {
    await createRelayMcpServer().connect(new StdioServerTransport());
  } catch {
    // Never stringify errors here: connection errors can include proxy URLs or
    // upstream messages, neither of which belongs on an MCP stdio host log.
    console.error('relay-mcp failed to start.');
    process.exitCode = 1;
  }
}
