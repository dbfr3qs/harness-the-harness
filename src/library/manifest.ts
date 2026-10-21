import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ConfigError } from "../config.ts";
import { parseMcpConfig } from "../mcp/config.ts";
import type { McpServerConfig } from "../mcp/config.ts";

export type ArtifactKind = "tool" | "skill" | "mcp";

export interface ToolEntry {
  kind: "tool";
  name: string;
  file: string; // relative to toolsDir
  enabled: boolean;
}
export interface SkillEntry {
  kind: "skill";
  name: string; // the skill dir
  description: string;
  enabled: boolean;
}
export interface McpEntry {
  kind: "mcp";
  name: string;
  server: McpServerConfig;
  enabled: boolean;
}
export type ManifestEntry = ToolEntry | SkillEntry | McpEntry;

/** The persisted, human-curated index of self-built artifacts. */
export interface Manifest {
  entries: ManifestEntry[];
}

const ENTRY_KEYS: Record<ArtifactKind, string[]> = {
  tool: ["kind", "name", "file", "enabled"],
  skill: ["kind", "name", "description", "enabled"],
  mcp: ["kind", "name", "server", "enabled"],
};

/** Checks parsed JSON and returns a Manifest, or throws ConfigError naming the problem. */
export function parseManifest(json: unknown, source: string): Manifest {
  const fail = (msg: string): never => {
    throw new ConfigError(`${source}: ${msg}`);
  };
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObject(json)) fail("must be a JSON object");
  const root = json as Record<string, unknown>;
  const extra = Object.keys(root).filter((k) => k !== "entries");
  if (extra.length) fail(`unknown key(s) ${extra.map((k) => `"${k}"`).join(", ")}; allowed: entries`);
  if (root.entries === undefined) return { entries: [] };
  if (!Array.isArray(root.entries)) fail('"entries" must be a list');

  const entries = (root.entries as unknown[]).map((raw, i): ManifestEntry => {
    const at = `entries[${i}]`;
    if (!isObject(raw)) fail(`"${at}" must be an object`);
    const e = raw as Record<string, unknown>;
    const kind = e.kind;
    if (kind !== "tool" && kind !== "skill" && kind !== "mcp") fail(`"${at}.kind" must be one of tool, skill, mcp`);
    const allowed = ENTRY_KEYS[kind as ArtifactKind];
    const unknown = Object.keys(e).filter((k) => !allowed.includes(k));
    if (unknown.length) fail(`unknown key(s) ${unknown.map((k) => `"${k}"`).join(", ")} in "${at}"; allowed: ${allowed.join(", ")}`);
    if (typeof e.name !== "string" || e.name.trim() === "") fail(`"${at}.name" must be a non-empty string`);
    if (typeof e.enabled !== "boolean") fail(`"${at}.enabled" must be true or false`);
    const name = e.name as string;
    const enabled = e.enabled as boolean;

    if (kind === "tool") {
      if (typeof e.file !== "string" || e.file.trim() === "") fail(`"${at}.file" must be a non-empty string`);
      return { kind, name, file: e.file as string, enabled };
    }
    if (kind === "skill") {
      if (typeof e.description !== "string") fail(`"${at}.description" must be a string`);
      return { kind, name, description: e.description as string, enabled };
    }
    // mcp: reuse the mcp.json rules by wrapping the one server.
    const [server] = parseMcpConfig({ mcpServers: { [name]: e.server } }, `${source}: ${at}.server`);
    return { kind: "mcp", name, server, enabled };
  });
  return { entries };
}

/** Reads the manifest. A missing file means an empty library; a broken one is an error. */
export async function loadManifest(path: string): Promise<Manifest> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { entries: [] };
    throw new ConfigError(`could not read manifest ${path}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  return parseManifest(json, path);
}

export function formatManifest(m: Manifest): string {
  const entries = m.entries.map((e) => {
    if (e.kind !== "mcp") return e;
    const { name: _name, ...server } = e.server; // the entry's name is the server's name
    return { kind: e.kind, name: e.name, server, enabled: e.enabled };
  });
  return `${JSON.stringify({ entries }, null, 2)}\n`;
}

/** Writes atomically (temp file, then rename), so a crash can't leave half a file. */
export async function saveManifest(path: string, m: Manifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, formatManifest(m), "utf8");
  await rename(tmp, path);
}
