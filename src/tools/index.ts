import type { McpServer } from '@modelcontextprotocol/server';
import type { ToolContext } from './context.js';
import { registerCheckAccessTool } from './check-access.js';

/**
 * Every tool this server exposes.
 *
 * To add one: write a `registerXTools(server, ctx)` function in a new file
 * beside these, then add one line here. That single line is the whole
 * registry — see docs/ADDING-A-TOOL.md.
 */
export function registerTools(server: McpServer, ctx: ToolContext): void {
    registerCheckAccessTool(server, ctx);
}

export { createToolContext, type ToolContext } from './context.js';
