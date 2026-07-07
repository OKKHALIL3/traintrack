#!/usr/bin/env node
// ─── traintrack MCP server entry point ──────────────────────────────────────
// The executable wired into .mcp.json. Claude Code launches this as a long-lived
// stdio process; it opens the Channel from TRAINTRACK_CHANNEL (default
// <cwd>/.traintrack/channel.db) and runs the JSON-RPC readline loop until stdin
// closes. All the logic lives in ./mcp/server.js — this file is just the shim.

import { runTraintrackMcpServer } from './mcp/server.js'

runTraintrackMcpServer()
