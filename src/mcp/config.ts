import { readFile } from "node:fs/promises";
import { ConfigError } from "../config.ts";
import type { McpServerSpec } from "./client.ts";

export const DEFAULT_MCP_CONFIG_PATH = "mcp.json";

/**
 * One server from mcp.json. The file uses Claude Code's `mcpServers` format, so an entry can be
 * copied across, plus a few harness keys: `tools` (an allowlist of exact names or `prefix*`),
 * `interactive`, and the timeouts.
 */
export interface McpServerConfig extends McpServerSpec {
  tools?: string[]; // unset: every tool the server offers
  // An MCP server is a program the harness starts, and its tools can do anything that program can,
  // so by default servers start only in unattended mode (inside a sandbox). `interactive: true`
  // also starts it in normal mode, where the user approves each call.
  interactive: boolean;
  startupTimeoutMs?: number;
  callTimeoutMs?: number;
}

const SERVER_KEYS = new Set(["type", "command", "args", "env", "tools", "interactive", "startupTimeoutMs", "callTimeoutMs"]);
const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;

/** Checks parsed JSON and returns the servers, or throws ConfigError naming the problem. */
export function parseMcpConfig(json: unknown, source: string): McpServerConfig[] {
  const fail = (msg: string): never => {
    throw new ConfigError(`${source}: ${msg}`);
  };
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObject(json)) fail("must be a JSON object");
  const root = json as Record<string, unknown>;
  const extra = Object.keys(root).filter((k) => k !== "mcpServers");
  if (extra.length) fail(`unknown key(s) ${extra.map((k) => `"${k}"`).join(", ")}; allowed: mcpServers`);
  if (root.mcpServers === undefined) return [];
  if (!isObject(root.mcpServers)) fail('"mcpServers" must be an object');

  return Object.entries(root.mcpServers as Record<string, unknown>).map(([name, raw]) => {
    const at = `mcpServers.${name}`;
    if (!NAME_PATTERN.test(name)) fail(`server name "${name}" must be 1 to 32 letters, digits, _ or -`);
    if (!isObject(raw)) fail(`"${at}" must be an object`);
    const s = raw as Record<string, unknown>;
    const unknown = Object.keys(s).filter((k) => !SERVER_KEYS.has(k));
    if (unknown.length) fail(`unknown key(s) ${unknown.map((k) => `"${k}"`).join(", ")} in "${at}"; allowed: ${[...SERVER_KEYS].join(", ")}`);
    if (s.type !== undefined && s.type !== "stdio") fail(`"${at}.type" is "${String(s.type)}"; only "stdio" servers are supported`);
    if (typeof s.command !== "string" || !s.command.trim()) fail(`"${at}.command" must be the program to run`);

    const out: McpServerConfig = { name, command: s.command as string, args: [], interactive: false };
    if (s.args !== undefined) {
      if (!Array.isArray(s.args) || !s.args.every((a) => typeof a === "string")) fail(`"${at}.args" must be a list of strings`);
      out.args = s.args as string[];
    }
    if (s.env !== undefined) {
      if (!isObject(s.env) || !Object.values(s.env).every((v) => typeof v === "string")) fail(`"${at}.env" must map names to strings`);
      out.env = s.env as Record<string, string>;
    }
    if (s.tools !== undefined) {
      if (!Array.isArray(s.tools) || s.tools.length === 0 || !s.tools.every((t) => typeof t === "string" && t.trim())) {
        fail(`"${at}.tools" must be a non-empty list of tool names (a trailing * matches a prefix); leave it out for every tool`);
      }
      out.tools = s.tools as string[];
    }
    if (s.interactive !== undefined) {
      if (typeof s.interactive !== "boolean") fail(`"${at}.interactive" must be true or false`);
      out.interactive = s.interactive as boolean;
    }
    for (const key of ["startupTimeoutMs", "callTimeoutMs"] as const) {
      const v = s[key];
      if (v === undefined) continue;
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) fail(`"${at}.${key}" must be a whole number of milliseconds, 1 or more`);
      out[key] = v as number;
    }
    return out;
  });
}

/** Reads mcp.json. A missing file means no servers, unless the path was given explicitly. */
export async function loadMcpConfig(path: string, required: boolean): Promise<McpServerConfig[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && !required) return [];
    throw new ConfigError(`could not read MCP config ${path}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  return parseMcpConfig(json, path);
}

/** The servers this mode may start: all of them when unattended, else only interactive ones. */
export function serversToStart(servers: McpServerConfig[], unattended: boolean): McpServerConfig[] {
  return unattended ? servers : servers.filter((s) => s.interactive);
}
