import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrarySession } from "../src/library/session.ts";
import type { LibrarySessionDeps } from "../src/library/session.ts";
import { defineTool, type Tool } from "../src/registry.ts";
import type { Manifest } from "../src/library/manifest.ts";
import type { McpServerConfig } from "../src/mcp/config.ts";
import type { StartedServer } from "../src/mcp/start.ts";
import { loadManifest } from "../src/library/manifest.ts";

// ---- fakes ------------------------------------------------------------------

function fakeRegistry() {
  const map = new Map<string, Tool>();
  return {
    map,
    add(t: Tool) {
      if (map.has(t.name)) throw new Error(`a tool named "${t.name}" is already loaded.`);
      map.set(t.name, t);
    },
    remove(name: string) {
      map.delete(name);
    },
    has(name: string) {
      return map.has(name);
    },
    names() {
      return [...map.keys()].sort();
    },
  };
}

function fakeStartServer() {
  const closed: string[] = [];
  const started: string[] = [];
  const startServer = async (s: McpServerConfig): Promise<StartedServer> => {
    started.push(s.name);
    const tools: Tool[] = [`${s.name}__a`, `${s.name}__b`].map((n) =>
      defineTool({ name: n, description: "d", input_schema: { type: "object", properties: {} }, handler: async () => "ok" }),
    );
    return {
      name: s.name,
      tools,
      instructions: `hello from ${s.name}`,
      warnings: [],
      close() {
        closed.push(s.name);
      },
    };
  };
  return { startServer, closed, started };
}

const toolDeps = { defineTool, workspaceRoot: "/ws", privatePaths: [] };
const tmp = () => mkdtemp(join(tmpdir(), "session-"));

const goodTool = (name: string, desc = "d") => `export default (deps) => deps.defineTool({
  name: ${JSON.stringify(name)}, description: ${JSON.stringify(desc)},
  input_schema: { type: "object", properties: {} },
  handler: async () => "ok",
});
`;
const badTool = `export default () => { throw new Error("factory boom"); };\n`;

function mkServer(name: string): McpServerConfig {
  return { name, command: "x", args: [], interactive: false };
}

async function makeSession(opts: {
  root: string;
  manifest?: Manifest;
  startServer?: LibrarySessionDeps["startServer"];
}) {
  const registry = fakeRegistry();
  const starter = opts.startServer ? { startServer: opts.startServer, closed: [] as string[], started: [] as string[] } : fakeStartServer();
  const deps: LibrarySessionDeps = {
    paths: {
      root: opts.root,
      toolsDir: join(opts.root, "tools"),
      skillsDir: join(opts.root, "skills"),
      manifestPath: join(opts.root, "manifest.json"),
    },
    manifest: opts.manifest ?? { entries: [] },
    toolDeps,
    registry,
    startServer: starter.startServer,
  };
  const session = await createLibrarySession(deps);
  return { session, registry, starter, deps };
}

// ---- tests ------------------------------------------------------------------

test("applyBaseline loads only enabled tools; a failing file is a warning not a throw", async () => {
  const root = await tmp();
  const toolsDir = join(root, "tools");
  await mkdir(toolsDir, { recursive: true });
  await writeFile(join(toolsDir, "good.ts"), goodTool("good"));
  await writeFile(join(toolsDir, "bad.ts"), badTool);
  // "off.ts" intentionally does NOT exist: a disabled entry must be skipped entirely.
  const manifest: Manifest = {
    entries: [
      { kind: "tool", name: "good", file: "good.ts", enabled: true },
      { kind: "tool", name: "off", file: "off.ts", enabled: false },
      { kind: "tool", name: "bad", file: "bad.ts", enabled: true },
    ],
  };
  const { session, registry } = await makeSession({ root, manifest });
  const res = await session.applyBaseline();
  assert.ok(registry.has("good"), "enabled good tool loaded");
  assert.ok(!registry.has("off"), "disabled tool skipped");
  assert.ok(!registry.has("bad"), "failing tool not registered");
  assert.ok(res.warnings.some((w) => w.includes("bad.ts")), `expected a warning naming bad.ts, got ${JSON.stringify(res.warnings)}`);
});

test("applyBaseline rejects a manifest tool file that escapes toolsDir (as a warning)", async () => {
  const root = await tmp();
  await mkdir(join(root, "tools"), { recursive: true });
  const manifest: Manifest = { entries: [{ kind: "tool", name: "evil", file: "../evil.ts", enabled: true }] };
  const { session, registry } = await makeSession({ root, manifest });
  const res = await session.applyBaseline();
  assert.ok(!registry.has("evil"));
  assert.ok(res.warnings.some((w) => /evil|escape|tools/i.test(w)), `expected a traversal warning, got ${JSON.stringify(res.warnings)}`);
});

test("reloadTools picks up a new file and reports a bad one in failed", async () => {
  const root = await tmp();
  const toolsDir = join(root, "tools");
  await mkdir(toolsDir, { recursive: true });
  await writeFile(join(toolsDir, "one.ts"), goodTool("one"));
  await writeFile(join(toolsDir, "broken.ts"), badTool);
  const { session, registry } = await makeSession({ root });
  const res = await session.reloadTools();
  assert.deepEqual(res.loaded, ["one"]);
  assert.equal(res.failed.length, 1);
  assert.ok(res.failed[0].file.endsWith("broken.ts"));
  assert.ok(res.failed[0].error.includes("broken.ts") || res.failed[0].error.includes("boom"));
  assert.ok(registry.has("one"));
});

test("addServer adds tools and tracks the handle; setEnabled mcp false closes and removes", async () => {
  const root = await tmp();
  await mkdir(join(root, "tools"), { recursive: true });
  const { session, registry, starter } = await makeSession({ root });
  const out = await session.addServer(mkServer("srv"));
  assert.deepEqual(out.tools.sort(), ["srv__a", "srv__b"]);
  assert.equal(out.instructions, "hello from srv");
  assert.ok(registry.has("srv__a") && registry.has("srv__b"));

  const line = await session.setEnabled("mcp", "srv", false);
  assert.ok(typeof line === "string" && line.length > 0);
  assert.deepEqual(starter.closed, ["srv"], "handle close() was called");
  assert.ok(!registry.has("srv__a") && !registry.has("srv__b"), "server tools removed");
});

test("diff reports a reloaded tool as added and a disabled baseline tool as enabledChanged", async () => {
  const root = await tmp();
  const toolsDir = join(root, "tools");
  await mkdir(toolsDir, { recursive: true });
  await writeFile(join(toolsDir, "base.ts"), goodTool("base"));
  await writeFile(join(toolsDir, "fresh.ts"), goodTool("fresh"));
  const manifest: Manifest = { entries: [{ kind: "tool", name: "base", file: "base.ts", enabled: true }] };
  const { session } = await makeSession({ root, manifest });
  await session.applyBaseline();
  await session.reloadTools();
  await session.setEnabled("tool", "base", false);
  const d = session.diff();
  assert.ok(d.added.some((a) => a.kind === "tool" && a.name === "fresh"), `expected fresh in added, got ${JSON.stringify(d.added)}`);
  assert.ok(!d.added.some((a) => a.name === "base"), "base is persisted, not added");
  assert.ok(
    d.enabledChanged.some((c) => c.kind === "tool" && c.name === "base" && c.enabled === false),
    `expected base disabled in enabledChanged, got ${JSON.stringify(d.enabledChanged)}`,
  );
});

test("persist writes only the selected overlay entries", async () => {
  const root = await tmp();
  const toolsDir = join(root, "tools");
  await mkdir(toolsDir, { recursive: true });
  await writeFile(join(toolsDir, "keep.ts"), goodTool("keep"));
  await writeFile(join(toolsDir, "skip.ts"), goodTool("skip"));
  const { session, deps } = await makeSession({ root });
  await session.reloadTools();
  await session.persist([{ kind: "tool", name: "keep" }], deps.paths.manifestPath);
  const written = await loadManifest(deps.paths.manifestPath);
  assert.equal(written.entries.length, 1);
  const e = written.entries[0];
  assert.equal(e.kind, "tool");
  assert.equal(e.name, "keep");
  assert.equal(e.enabled, true);
  assert.equal((e as { file: string }).file, "keep.ts");
});

test("closeAll closes every tracked server handle", async () => {
  const root = await tmp();
  await mkdir(join(root, "tools"), { recursive: true });
  const { session, starter } = await makeSession({ root });
  await session.addServer(mkServer("one"));
  await session.addServer(mkServer("two"));
  session.closeAll();
  assert.deepEqual(starter.closed.sort(), ["one", "two"]);
});
