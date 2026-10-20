import type { Tool } from "../registry.ts";
import { connectMcpServer } from "./client.ts";
import type { McpConnection } from "./client.ts";
import type { McpServerConfig } from "./config.ts";
import { createMcpTools } from "./tools.ts";
import type { McpToolOptions } from "./tools.ts";

export interface McpStartOptions {
  hiddenEnv: string[]; // environment variables no server may see (API keys)
  /** Asks before each call to an interactive server's tools; unset in unattended mode. */
  confirm?: McpToolOptions["confirm"];
}

export interface McpStartResult {
  tools: Tool[];
  systemPrompt: string; // the servers' own instructions, to append to the system prompt
  notes: string[]; // one line per server that started
  warnings: string[]; // servers that failed to start, allowlist patterns that matched nothing
  close(): void;
}

/**
 * Starts the servers in parallel. One that fails to start is reported and left out, rather than
 * stopping the harness: the built-in tools still work without it.
 */
export async function startMcpServers(servers: McpServerConfig[], opts: McpStartOptions): Promise<McpStartResult> {
  const results = await Promise.allSettled(
    servers.map((s) =>
      connectMcpServer(s, {
        hiddenEnv: opts.hiddenEnv,
        ...(s.startupTimeoutMs ? { startupTimeoutMs: s.startupTimeoutMs } : {}),
        ...(s.callTimeoutMs ? { callTimeoutMs: s.callTimeoutMs } : {}),
      }),
    ),
  );
  const connections: McpConnection[] = [];
  const tools: Tool[] = [];
  const notes: string[] = [];
  const warnings: string[] = [];
  let systemPrompt = "";
  results.forEach((r, i) => {
    const s = servers[i]!;
    if (r.status === "rejected") {
      warnings.push(`${r.reason instanceof Error ? r.reason.message : String(r.reason)} (its tools are unavailable)`);
      return;
    }
    const conn = r.value;
    connections.push(conn);
    const made = createMcpTools(conn, { ...(s.tools ? { allow: s.tools } : {}), ...(s.interactive && opts.confirm ? { confirm: opts.confirm } : {}) });
    tools.push(...made.tools);
    for (const p of made.unmatched) warnings.push(`MCP server "${s.name}": "${p}" matched no tool`);
    for (const name of made.skipped) warnings.push(`MCP server "${s.name}": skipped "${name}", whose name is too long for the API`);
    // What the model is sent for every request; ~4 characters per token.
    const chars = made.tools.reduce((n, t) => n + JSON.stringify({ name: t.name, description: t.description, input_schema: t.input_schema }).length, 0);
    notes.push(`MCP server "${s.name}": ${made.tools.length} tool(s), ~${Math.ceil(chars / 4).toLocaleString("en-US")} tokens of definitions per request`);
    if (conn.instructions && made.tools.length) {
      systemPrompt += `\n\n# Instructions from MCP server "${s.name}" (its tools are named ${s.name}__<tool>)\n${conn.instructions.trim()}`;
    }
  });
  return {
    tools,
    systemPrompt,
    notes,
    warnings,
    close: () => connections.forEach((c) => c.close()),
  };
}
