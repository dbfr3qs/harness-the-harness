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

export interface StartedServer {
  name: string;
  tools: Tool[];
  instructions?: string; // the server's own text, as it sent it
  warnings: string[]; // allowlist patterns that matched nothing, tools skipped for long names
  close(): void; // stops just this server
}

/** Starts one server and builds its tools. Throws an Error saying why if it cannot start. */
export async function startOneServer(server: McpServerConfig, opts: McpStartOptions): Promise<StartedServer> {
  const conn = await connectMcpServer(server, {
    hiddenEnv: opts.hiddenEnv,
    ...(server.startupTimeoutMs ? { startupTimeoutMs: server.startupTimeoutMs } : {}),
    ...(server.callTimeoutMs ? { callTimeoutMs: server.callTimeoutMs } : {}),
  });
  try {
    const made = createMcpTools(conn, { ...(server.tools ? { allow: server.tools } : {}), ...(server.interactive && opts.confirm ? { confirm: opts.confirm } : {}) });
    const warnings = [
      ...made.unmatched.map((p) => `MCP server "${server.name}": "${p}" matched no tool`),
      ...made.skipped.map((n) => `MCP server "${server.name}": skipped "${n}", whose name is too long for the API`),
    ];
    return { name: server.name, tools: made.tools, ...(conn.instructions ? { instructions: conn.instructions } : {}), warnings, close: () => conn.close() };
  } catch (e) {
    conn.close();
    throw e;
  }
}

/**
 * Starts the servers in parallel. One that fails to start is reported and left out, rather than
 * stopping the harness: the built-in tools still work without it.
 */
export async function startMcpServers(servers: McpServerConfig[], opts: McpStartOptions): Promise<McpStartResult> {
  const results = await Promise.allSettled(servers.map((s) => startOneServer(s, opts)));
  const started: StartedServer[] = [];
  const tools: Tool[] = [];
  const notes: string[] = [];
  const warnings: string[] = [];
  let systemPrompt = "";
  results.forEach((r) => {
    if (r.status === "rejected") {
      warnings.push(`${r.reason instanceof Error ? r.reason.message : String(r.reason)} (its tools are unavailable)`);
      return;
    }
    const s = r.value;
    started.push(s);
    tools.push(...s.tools);
    warnings.push(...s.warnings);
    // What the model is sent for every request; ~4 characters per token.
    const chars = s.tools.reduce((n, t) => n + JSON.stringify({ name: t.name, description: t.description, input_schema: t.input_schema }).length, 0);
    notes.push(`MCP server "${s.name}": ${s.tools.length} tool(s), ~${Math.ceil(chars / 4).toLocaleString("en-US")} tokens of definitions per request`);
    if (s.instructions && s.tools.length) {
      systemPrompt += `\n\n# Instructions from MCP server "${s.name}" (its tools are named ${s.name}__<tool>)\n${s.instructions.trim()}`;
    }
  });
  return {
    tools,
    systemPrompt,
    notes,
    warnings,
    close: () => started.forEach((s) => s.close()),
  };
}
