import { defineTool } from "../registry.ts";
import type { Tool } from "../registry.ts";
import type { JsonSchema } from "../types.ts";
import type { McpConnection } from "./client.ts";

export interface McpToolOptions {
  allow?: string[]; // exact tool names, or `prefix*`; unset: every tool
  /** Asks the user to approve a call. Unset: every call runs (unattended mode). */
  confirm?: (toolName: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<boolean>;
}

const MAX_NAME = 128;

function allowed(name: string, patterns: string[] | undefined): boolean {
  return !patterns || patterns.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));
}

/**
 * Turns a connected server's tools into harness tools named `<server>__<tool>`, so they can't
 * collide with the built-in tools or with another server's. Schemas are passed to the API as the
 * server wrote them; the registry checks only what it understands (unknown keys, required keys).
 */
export function createMcpTools(conn: McpConnection, opts: McpToolOptions): { tools: Tool[]; unmatched: string[]; skipped: string[] } {
  const unmatched = (opts.allow ?? []).filter((p) => !conn.tools.some((t) => allowed(t.name, [p])));
  const skipped: string[] = [];
  const tools: Tool[] = [];
  for (const info of conn.tools) {
    if (!allowed(info.name, opts.allow)) continue;
    const name = `${conn.name}__${info.name}`;
    if (name.length > MAX_NAME) {
      skipped.push(info.name);
      continue;
    }
    tools.push(
      defineTool({
        name,
        description: info.description ?? "",
        input_schema: info.inputSchema as JsonSchema,
        handler: async (input, ctx) => {
          if (opts.confirm && !(await opts.confirm(name, input, ctx.signal))) {
            throw new Error(`the user declined to run ${name}. Do not retry it; ask the user how they would like to proceed.`);
          }
          const result = await conn.callTool(info.name, input, ctx.signal);
          if (result.isError) throw new Error(result.text);
          return result.text;
        },
      }),
    );
  }
  return { tools, unmatched, skipped };
}
