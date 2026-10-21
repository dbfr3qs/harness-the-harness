import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { assembleTools } from "../src/agent_tools.ts";
import type { Tool } from "../src/registry.ts";
import { parseMcpConfig, serversToStart } from "../src/mcp/config.ts";

// The model acts only through tools, so src/tools/ is the boundary of what it can do. The
// read-only tools live directly in src/tools/ and may never write files or run programs. The two
// tools that can — run_shell and write_file — live in src/tools/unattended/ and are added only in
// unattended mode (see src/agent_tools.ts), which is meant to run inside an isolated sandbox.
// Adding another writing or executing tool needs the owner's approval (see the spec); put it under
// unattended/, keep it out of the normal tool set, and make it refuse the settings files.

const toolsDir = new URL("../src/tools/", import.meta.url);

/** The read-only tools: *.ts directly in src/tools/, not the unattended/ subdirectory. */
const interactiveSources = async () =>
  Promise.all(
    (await readdir(toolsDir)).filter((f) => f.endsWith(".ts")).map(async (f) => ({ f, text: await readFile(new URL(f, toolsDir), "utf8") })),
  );

/** Every tool source, including src/tools/unattended/. */
const allSources = async () =>
  Promise.all(
    (await readdir(toolsDir, { recursive: true }))
      .filter((f) => f.endsWith(".ts"))
      .map(async (f) => ({ f, text: await readFile(new URL(f, toolsDir), "utf8") })),
  );

test("no interactive tool can write, delete, move or execute anything", async () => {
  const forbidden =
    /\b(writeFile|appendFile|createWriteStream|rename|rm|rmdir|unlink|mkdir|copyFile|cp|chmod|chown|truncate|symlink|link|utimes|open)\s*\(|node:child_process|node:worker_threads|node:vm|\bspawn\b|\bexecFile\b|\bexec\s*\(|\beval\s*\(|new Function\b/;
  const files = await interactiveSources();
  assert.ok(files.length >= 6, "found the tool sources");
  for (const { f, text } of files) {
    const hit = text.split("\n").findIndex((line) => forbidden.test(line));
    assert.equal(hit, -1, `src/tools/${f}:${hit + 1} uses a write or exec API: ${text.split("\n")[hit]?.trim()}`);
  }
});

test("no tool can reach the code that saves settings, the policy or transcripts", async () => {
  const writers = /from "\.\.\/(\.\.\/)?(settings|defaults_command|policy_command|log|model_command|turns_command)\.ts"/;
  for (const { f, text } of await allSources()) {
    assert.doesNotMatch(text, writers, `src/tools/${f} imports a module that writes settings or logs`);
  }
});

const stubWebFetch: Tool = {
  name: "web_fetch",
  description: "",
  input_schema: { type: "object", properties: {} },
  handler: async () => "",
};
// The self-extension tools (run_shell/write_file can already load code and start servers, so these
// can too) must only ever appear in unattended mode. Stubs stand in for them here so we can assert
// the exact unattended set and their order without pulling in a real LibrarySession.
const libStub = (name: string): Tool => ({ ...stubWebFetch, name });
const libraryTools: Tool[] = ["reload_tools", "add_mcp_server", "set_artifact_enabled", "list_catalog", "use_skill"].map(libStub);
const libraryNames = libraryTools.map((t) => t.name);
const build = (unattended: boolean) =>
  assembleTools({ workspaceRoot: "/tmp", privatePaths: [], webFetch: stubWebFetch, unattended, libraryTools: unattended ? libraryTools : [] }).map((t) => t.name);

test("the normal tool set is read-only: no run_shell, write_file, or library tools", () => {
  const names = build(false);
  assert.ok(!names.includes("run_shell"), "run_shell must not be registered outside unattended mode");
  assert.ok(!names.includes("write_file"), "write_file must not be registered outside unattended mode");
  for (const n of libraryNames) assert.ok(!names.includes(n), `${n} must not be registered outside unattended mode`);
  assert.deepEqual(names, ["get_time", "list_dir", "read_file", "web_fetch"]);
});

test("unattended mode adds run_shell, write_file and the library tools, and nothing else", () => {
  const names = build(true);
  assert.deepEqual(names, ["get_time", "list_dir", "read_file", "web_fetch", "run_shell", "write_file", ...libraryNames]);
});

// Defense in depth: assembleTools must refuse to register library tools in normal mode even when a
// caller mistakenly passes them. The unattended gate is the single guarantee, not the caller.
test("normal mode drops library tools even if a caller passes them", () => {
  const names = assembleTools({
    workspaceRoot: "/tmp",
    privatePaths: [],
    webFetch: stubWebFetch,
    unattended: false,
    libraryTools: [libStub("reload_tools")],
  }).map((t) => t.name);
  assert.ok(!names.includes("reload_tools"), "a library tool passed in normal mode must not be registered");
  assert.deepEqual(names, ["get_time", "list_dir", "read_file", "web_fetch"]);
});

// MCP servers are programs the harness starts, so their tools can do anything those programs can.
// Normal mode starts only servers marked "interactive" (and asks before each call, in src/repl.ts);
// the rest start only in unattended mode.
test("normal mode starts no MCP server unless it is marked interactive", () => {
  const servers = parseMcpConfig({ mcpServers: { rea: { command: "rea" }, docs: { command: "docs", interactive: true } } }, "mcp.json");
  assert.deepEqual(serversToStart(servers, false).map((s) => s.name), ["docs"]);
});

test("library tools come after the built-in tools and before the MCP tools", () => {
  const mcpTool: Tool = { ...stubWebFetch, name: "rea__open_binary" };
  const names = assembleTools({
    workspaceRoot: "/tmp",
    privatePaths: [],
    webFetch: stubWebFetch,
    unattended: true,
    libraryTools,
    mcpTools: [mcpTool],
  }).map((t) => t.name);
  assert.deepEqual(names, ["get_time", "list_dir", "read_file", "web_fetch", "run_shell", "write_file", ...libraryNames, "rea__open_binary"]);
});
