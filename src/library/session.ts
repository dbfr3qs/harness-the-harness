import { copyFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { Tool } from "../registry.ts";
import type { McpServerConfig } from "../mcp/config.ts";
import type { StartedServer } from "../mcp/start.ts";
import { loadToolFile, scanToolsDir, type ToolFactoryDeps } from "./loader.ts";
import { readSkill, scanSkillsDir, type SkillInfo } from "./skills.ts";
import { saveManifest, type ArtifactKind, type Manifest, type ManifestEntry } from "./manifest.ts";
import type { LibraryPaths } from "./paths.ts";

export interface LibrarySessionDeps {
  paths: LibraryPaths;
  manifest: Manifest; // the persisted, human-curated baseline
  toolDeps: ToolFactoryDeps;
  registry: { add(t: Tool): void; remove(name: string): void; has(name: string): boolean };
  startServer(s: McpServerConfig): Promise<StartedServer>;
}

export interface LibrarySession {
  /** Absolute path of the tools directory, where authored tool files belong. */
  readonly toolsDir: string;
  /** Scan toolsDir and (re)load every tool file into the registry. Does not touch the manifest. */
  reloadTools(): Promise<{ loaded: string[]; failed: { file: string; error: string }[] }>;
  /** Start a server, register its tools, track the handle. Throws (adding nothing) on failure. */
  addServer(server: McpServerConfig): Promise<{ tools: string[]; instructions?: string }>;
  /** Session-only enable/disable. Returns a human-readable line. */
  setEnabled(kind: ArtifactKind, name: string, enabled: boolean): Promise<string>;
  listSkills(): SkillInfo[];
  readSkill(name: string): Promise<string>;
  inventory(): { kind: ArtifactKind; name: string; enabled: boolean; persisted: boolean; description?: string }[];
  diff(): { added: { kind: ArtifactKind; name: string }[]; enabledChanged: { kind: ArtifactKind; name: string; enabled: boolean }[] };
  /** Human-only: fold the selected overlay changes into the manifest and save it. */
  persist(selection: { kind: ArtifactKind; name: string }[], manifestPath: string): Promise<void>;
  /** Close every server this session started (for quit). */
  closeAll(): void;
}

interface ToolRec {
  enabled: boolean;
  description?: string;
  persisted: boolean;
  file?: string; // absolute path last loaded from
  manifestFile?: string; // the relative `file` string from the baseline manifest
}
interface SkillRec {
  enabled: boolean;
  persisted: boolean;
  description: string;
}
interface McpRec {
  enabled: boolean;
  description?: string;
  persisted: boolean;
  server: McpServerConfig;
  handle?: StartedServer;
  toolNames: string[]; // the tools currently registered for this server
}

export async function createLibrarySession(deps: LibrarySessionDeps): Promise<LibrarySession> {
  const { paths, registry, toolDeps, startServer } = deps;
  const toolsDir = resolve(paths.toolsDir);

  const tools = new Map<string, ToolRec>();
  const skills = new Map<string, SkillRec>();
  const mcps = new Map<string, McpRec>();

  // Seed the overlay from the persisted baseline. The catalog is dormant: tools and servers are
  // known but NOT loaded (enabled: false) until setEnabled loads them on demand. A skill's flag
  // means "offered", a human preference honored at startup, so it keeps its persisted value.
  for (const e of deps.manifest.entries) {
    if (e.kind === "tool") tools.set(e.name, { enabled: false, persisted: true, manifestFile: e.file, description: e.description });
    else if (e.kind === "skill") skills.set(e.name, { enabled: e.enabled, persisted: true, description: e.description });
    else mcps.set(e.name, { enabled: false, persisted: true, server: e.server, toolNames: [], description: e.description });
  }

  // Resolve a tool file under toolsDir, refusing any path that escapes it (a manifest `file` of
  // "../x" must not reach outside the tools directory).
  function resolveToolFile(rel: string): string {
    const abs = resolve(toolsDir, rel);
    const within = relative(toolsDir, abs);
    if (within === "" || within.startsWith("..") || isAbsolute(within)) {
      throw new Error(
        `tool file "${rel}" escapes the tools directory ${toolsDir}. A tool's file must sit inside the tools directory; use a plain filename like "my_tool.ts".`,
      );
    }
    return abs;
  }

  function removeServerTools(rec: McpRec): void {
    for (const n of rec.toolNames) if (registry.has(n)) registry.remove(n);
    rec.toolNames = [];
  }

  async function startAndRegister(rec: McpRec): Promise<StartedServer> {
    const handle = await startServer(rec.server);
    const added: string[] = [];
    try {
      for (const t of handle.tools) {
        registry.add(t);
        added.push(t.name);
      }
    } catch (err) {
      for (const n of added) if (registry.has(n)) registry.remove(n);
      handle.close();
      throw err;
    }
    rec.handle = handle;
    rec.toolNames = handle.tools.map((t) => t.name);
    rec.enabled = true;
    return handle;
  }

  function disableServer(rec: McpRec): void {
    if (rec.handle) {
      rec.handle.close();
      rec.handle = undefined;
    }
    removeServerTools(rec);
    rec.enabled = false;
  }

  const session: LibrarySession = {
    toolsDir,
    async reloadTools() {
      const loaded: string[] = [];
      const failed: { file: string; error: string }[] = [];
      const seen = new Set<string>();
      for (const file of await scanToolsDir(toolsDir)) {
        try {
          const tool = await loadToolFile(file, toolDeps);
          const name = tool.name;
          if (seen.has(name)) {
            throw new Error(`a tool named "${name}" was already loaded from another file in this scan; each tool needs a unique name.`);
          }
          // Replace any version of this name we loaded before (session or baseline); a name the
          // registry holds but we do not own is a built-in, so registry.add will reject it below.
          if (tools.has(name) && registry.has(name)) registry.remove(name);
          registry.add(tool);
          const prior = tools.get(name);
          tools.set(name, { enabled: true, persisted: prior?.persisted ?? false, file, manifestFile: prior?.manifestFile });
          seen.add(name);
          loaded.push(name);
        } catch (err) {
          failed.push({ file, error: message(err) });
        }
      }
      return { loaded, failed };
    },

    async addServer(server) {
      const existing = mcps.get(server.name);
      const persisted = existing?.persisted ?? false;
      const rec: McpRec = { enabled: false, persisted, server, toolNames: [] };
      // Start the replacement FIRST so a failure leaves any running same-named server untouched.
      let handle: StartedServer;
      try {
        handle = await startServer(server);
      } catch (err) {
        throw new Error(`Could not add MCP server "${server.name}": ${message(err)}. Nothing was added.`);
      }
      // Swap: take the old server's tools out, register the new ones, and put the old back if that fails.
      const oldNames = existing ? [...existing.toolNames] : [];
      const oldTools = new Map<string, Tool>();
      if (existing) {
        for (const t of existing.handle?.tools ?? []) oldTools.set(t.name, t);
        removeServerTools(existing);
      }
      const added: string[] = [];
      try {
        for (const t of handle.tools) {
          registry.add(t);
          added.push(t.name);
        }
      } catch (err) {
        for (const n of added) if (registry.has(n)) registry.remove(n);
        handle.close();
        if (existing) {
          for (const n of oldNames) {
            const t = oldTools.get(n);
            if (t && !registry.has(n)) registry.add(t);
          }
          existing.toolNames = oldNames;
        }
        throw new Error(`Could not add MCP server "${server.name}": ${message(err)}. Nothing was added.`);
      }
      if (existing?.handle) existing.handle.close();
      rec.handle = handle;
      rec.toolNames = added;
      rec.enabled = true;
      mcps.set(server.name, rec);
      return { tools: rec.toolNames, ...(handle.instructions ? { instructions: handle.instructions } : {}) };
    },

    async setEnabled(kind, name, enabled) {
      if (kind === "tool") {
        const rec = tools.get(name);
        if (!rec) throw new Error(`No tool "${name}" in the library. Reload tools or add it first.`);
        if (enabled) {
          const abs = rec.file ?? (rec.manifestFile ? resolveToolFile(rec.manifestFile) : undefined);
          if (!abs) throw new Error(`Cannot enable tool "${name}": its file is unknown. Reload tools first.`);
          const tool = await loadToolFile(abs, toolDeps);
          if (registry.has(name)) registry.remove(name);
          registry.add(tool);
          rec.file = abs;
          rec.enabled = true;
          return `Enabled tool "${name}".`;
        }
        if (registry.has(name)) registry.remove(name);
        rec.enabled = false;
        return `Disabled tool "${name}".`;
      }
      if (kind === "mcp") {
        const rec = mcps.get(name);
        if (!rec) throw new Error(`No MCP server "${name}" in the library. Add it first.`);
        if (enabled) {
          if (rec.enabled && rec.handle) return `MCP server "${name}" is already enabled.`;
          await startAndRegister(rec);
          return `Enabled MCP server "${name}" (${rec.toolNames.length} tool(s)).`;
        }
        disableServer(rec);
        return `Disabled MCP server "${name}".`;
      }
      // skill: session-only flag; nothing to load into the registry.
      const rec = skills.get(name);
      if (!rec) throw new Error(`No skill "${name}" in the library.`);
      rec.enabled = enabled;
      return `${enabled ? "Enabled" : "Disabled"} skill "${name}".`;
    },

    listSkills() {
      return [...skills.entries()]
        .filter(([, rec]) => rec.enabled)
        .map(([name, rec]) => ({ name, description: rec.description, dir: join(paths.skillsDir, name) }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },

    readSkill(name) {
      return readSkill(paths.skillsDir, name);
    },

    inventory() {
      const out: { kind: ArtifactKind; name: string; enabled: boolean; persisted: boolean; description?: string }[] = [];
      for (const [name, rec] of tools) out.push({ kind: "tool", name, enabled: rec.enabled, persisted: rec.persisted, description: rec.description });
      for (const [name, rec] of skills) out.push({ kind: "skill", name, enabled: rec.enabled, persisted: rec.persisted, description: rec.description });
      for (const [name, rec] of mcps) out.push({ kind: "mcp", name, enabled: rec.enabled, persisted: rec.persisted, description: rec.description });
      return out;
    },

    diff() {
      const added: { kind: ArtifactKind; name: string }[] = [];
      const enabledChanged: { kind: ArtifactKind; name: string; enabled: boolean }[] = [];
      const baseline = new Map<string, boolean>();
      for (const e of deps.manifest.entries) baseline.set(`${e.kind}:${e.name}`, e.enabled);
      const consider = (kind: ArtifactKind, name: string, enabled: boolean, persisted: boolean) => {
        if (!persisted) {
          added.push({ kind, name });
        } else {
          const was = baseline.get(`${kind}:${name}`);
          if (was !== undefined && was !== enabled) enabledChanged.push({ kind, name, enabled });
        }
      };
      for (const [name, rec] of tools) consider("tool", name, rec.enabled, rec.persisted);
      for (const [name, rec] of skills) consider("skill", name, rec.enabled, rec.persisted);
      for (const [name, rec] of mcps) consider("mcp", name, rec.enabled, rec.persisted);
      return { added, enabledChanged };
    },

    async persist(selection, manifestPath) {
      // Start from the baseline and fold in only the selected overlay changes, preserving order.
      const byKey = new Map<string, ManifestEntry>();
      const order: string[] = [];
      for (const e of deps.manifest.entries) {
        const key = `${e.kind}:${e.name}`;
        byKey.set(key, e);
        order.push(key);
      }

      for (const sel of selection) {
        const key = `${sel.kind}:${sel.name}`;
        const entry = await buildEntry(sel.kind, sel.name);
        if (!byKey.has(key)) order.push(key);
        byKey.set(key, entry);
      }

      const entries = order.map((k) => byKey.get(k)!);
      await saveManifest(manifestPath, { entries });

      // The written manifest is the new baseline: reflect it so later diffs compare against it.
      deps.manifest = { entries };
      for (const sel of selection) {
        if (sel.kind === "tool") {
          const rec = tools.get(sel.name);
          if (rec) rec.persisted = true;
        } else if (sel.kind === "skill") {
          const rec = skills.get(sel.name);
          if (rec) rec.persisted = true;
        } else {
          const rec = mcps.get(sel.name);
          if (rec) rec.persisted = true;
        }
      }
    },

    closeAll() {
      for (const rec of mcps.values()) {
        if (rec.handle) {
          rec.handle.close();
          rec.handle = undefined;
        }
      }
    },
  };

  async function buildEntry(kind: ArtifactKind, name: string): Promise<ManifestEntry> {
    if (kind === "tool") {
      const rec = tools.get(name);
      if (!rec) throw new Error(`Cannot persist tool "${name}": it is not in this session.`);
      let file: string;
      if (rec.persisted && rec.manifestFile) {
        file = rec.manifestFile; // keep the human-chosen location
      } else {
        if (!rec.file) throw new Error(`Cannot persist tool "${name}": its file is unknown.`);
        const dest = join(toolsDir, basename(rec.file));
        if (resolve(rec.file) !== resolve(dest)) {
          await copyFile(rec.file, dest);
          rec.file = dest;
        }
        file = basename(dest);
        rec.manifestFile = file;
      }
      return { kind: "tool", name, file, enabled: rec.enabled };
    }
    if (kind === "skill") {
      const rec = skills.get(name);
      if (!rec) throw new Error(`Cannot persist skill "${name}": it is not in this session.`);
      return { kind: "skill", name, description: rec.description, enabled: rec.enabled };
    }
    const rec = mcps.get(name);
    if (!rec) throw new Error(`Cannot persist MCP server "${name}": it is not in this session.`);
    return { kind: "mcp", name, server: rec.server, enabled: rec.enabled };
  }

  return session;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
