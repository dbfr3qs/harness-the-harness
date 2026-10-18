import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { assembleTools } from "../src/agent_tools.ts";
import type { Tool } from "../src/registry.ts";

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
const build = (unattended: boolean) =>
  assembleTools({ workspaceRoot: "/tmp", privatePaths: [], webFetch: stubWebFetch, unattended }).map((t) => t.name);

test("run_shell and write_file are absent from the normal tool set", () => {
  const names = build(false);
  assert.ok(!names.includes("run_shell"), "run_shell must not be registered outside unattended mode");
  assert.ok(!names.includes("write_file"), "write_file must not be registered outside unattended mode");
  assert.deepEqual(names, ["get_time", "list_dir", "read_file", "web_fetch"]);
});

test("unattended mode adds run_shell and write_file, and nothing else", () => {
  const names = build(true);
  assert.deepEqual(names, ["get_time", "list_dir", "read_file", "web_fetch", "run_shell", "write_file"]);
});
