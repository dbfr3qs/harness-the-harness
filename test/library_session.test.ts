import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
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

test("a fresh session loads nothing: enabled baseline tools and servers stay dormant", async () => {
  const root = await tmp();
  const toolsDir = join(root, "tools");
  await mkdir(toolsDir, { recursive: true });
  await writeFile(join(toolsDir, "good.ts"), goodTool("good"));
  const manifest: Manifest = {
    entries: [
      { kind: "tool", name: "good", file: "good.ts", enabled: true, description: "a good tool" },
      { kind: "mcp", name: "srv", server: mkServer("srv"), enabled: true, description: "a server" },
      { kind: "skill", name: "sk", description: "a skill", enabled: true },
    ],
  };
  const { session, registry, starter } = await makeSession({ root, manifest });
  assert.deepEqual(registry.names(), [], "nothing registered");
  assert.deepEqual(starter.started, [], "no server started");
  const inv = session.inventory();
  assert.deepEqual(inv.find((i) => i.kind === "tool"), { kind: "tool", name: "good", enabled: false, persisted: true, description: "a good tool" });
  assert.deepEqual(inv.find((i) => i.kind === "mcp"), { kind: "mcp", name: "srv", enabled: false, persisted: true, description: "a server" });
  assert.equal(inv.find((i) => i.kind === "skill")?.enabled, true, "skill seeds as offered");
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

test("persist leaves a tool already in toolsDir untouched and records it by basename", async () => {
  // The copyFile branch (source outside toolsDir) is defensive: sessions only load from toolsDir,
  // so a rec.file outside it is unreachable through the public API.
  const root = await tmp();
  const toolsDir = join(root, "tools");
  await mkdir(toolsDir, { recursive: true });
  await writeFile(join(toolsDir, "inplace.ts"), goodTool("inplace"));
  const { session, deps } = await makeSession({ root });
  await session.reloadTools();
  await session.persist([{ kind: "tool", name: "inplace" }], deps.paths.manifestPath);
  assert.equal(await readFile(join(toolsDir, "inplace.ts"), "utf8"), goodTool("inplace"));
  const e = (await loadManifest(deps.paths.manifestPath)).entries[0] as { file: string };
  assert.equal(e.file, "inplace.ts");
});

test("addServer failed replace leaves the prior server running", async () => {
  const root = await tmp();
  await mkdir(join(root, "tools"), { recursive: true });
  let fail = false;
  const base = fakeStartServer();
  const startServer = async (s: McpServerConfig) => {
    if (fail) throw new Error("spawn failed");
    return base.startServer(s);
  };
  const { session, registry } = await makeSession({ root, startServer });
  await session.addServer(mkServer("srv"));
  fail = true;
  await assert.rejects(session.addServer(mkServer("srv")), /spawn failed/);
  assert.ok(registry.has("srv__a") && registry.has("srv__b"), "prior server's tools survive");
  assert.deepEqual(base.closed, [], "prior server was not closed");
  fail = false;
  await session.addServer(mkServer("srv"));
  assert.deepEqual(base.closed, ["srv"], "successful replace closes the old handle");
  assert.ok(registry.has("srv__a"));
});

test("addServer stores its description and inventory exposes it", async () => {
  const root = await tmp();
  await mkdir(join(root, "tools"), { recursive: true });
  const { session } = await makeSession({ root });
  await session.addServer(mkServer("rev"), "a reverse-engineering server");
  assert.equal(session.inventory().find((i) => i.kind === "mcp" && i.name === "rev")?.description, "a reverse-engineering server");
});

test("reloadTools captures a loaded tool's description into inventory", async () => {
  const root = await tmp();
  const toolsDir = join(root, "tools");
  await mkdir(toolsDir, { recursive: true });
  await writeFile(join(toolsDir, "hi.ts"), goodTool("hi", "greets"));
  const { session } = await makeSession({ root });
  await session.reloadTools();
  assert.equal(session.inventory().find((i) => i.kind === "tool" && i.name === "hi")?.description, "greets");
});

test("enabling a cataloged tool captures its loaded description", async () => {
  const root = await tmp();
  const toolsDir = join(root, "tools");
  await mkdir(toolsDir, { recursive: true });
  await writeFile(join(toolsDir, "hi.ts"), goodTool("hi", "greets"));
  const manifest: Manifest = { entries: [{ kind: "tool", name: "hi", file: "hi.ts", enabled: true }] };
  const { session } = await makeSession({ root, manifest });
  await session.setEnabled("tool", "hi", true);
  assert.equal(session.inventory().find((i) => i.name === "hi")?.description, "greets");
});

test("enabling a cataloged tool whose file is missing throws and keeps the entry", async () => {
  const root = await tmp();
  await mkdir(join(root, "tools"), { recursive: true });
  const manifest: Manifest = { entries: [{ kind: "tool", name: "gone", file: "gone.ts", enabled: true }] };
  const { session } = await makeSession({ root, manifest });
  await assert.rejects(session.setEnabled("tool", "gone", true), /gone\.ts/);
  const row = session.inventory().find((i) => i.name === "gone");
  assert.ok(row);
  assert.equal(row.enabled, false);
});

test("enabling a tool whose manifest file escapes toolsDir is rejected and the entry stays cataloged", async () => {
  const root = await tmp();
  await mkdir(join(root, "tools"), { recursive: true });
  await writeFile(join(root, "escape.ts"), goodTool("esc"));
  const manifest: Manifest = { entries: [{ kind: "tool", name: "esc", file: "../escape.ts", enabled: true }] };
  const { session, registry } = await makeSession({ root, manifest });
  await assert.rejects(session.setEnabled("tool", "esc", true), /escapes the tools directory/);
  assert.equal(registry.has("esc"), false);
  const row = session.inventory().find((i) => i.name === "esc");
  assert.ok(row);
  assert.equal(row.enabled, false);
});

test("enabling a cataloged mcp whose start rejects surfaces the error and keeps the entry", async () => {
  const root = await tmp();
  await mkdir(join(root, "tools"), { recursive: true });
  const manifest: Manifest = { entries: [{ kind: "mcp", name: "bad", server: mkServer("bad"), enabled: true }] };
  const { session } = await makeSession({
    root,
    manifest,
    startServer: async () => {
      throw new Error("spawn failed");
    },
  });
  await assert.rejects(session.setEnabled("mcp", "bad", true), /spawn failed/);
  const row = session.inventory().find((i) => i.name === "bad");
  assert.ok(row);
  assert.equal(row.enabled, false);
});
