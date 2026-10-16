import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

// The model acts only through tools, so src/tools/ is the boundary of what it can do. These checks
// make sure no tool can change files (including harness.json and the web policy) or run programs.
// Adding a tool that writes files or runs shell commands needs the owner's approval (see the spec);
// if one is approved, update this test deliberately and make the tool refuse the settings files.

const toolsDir = new URL("../src/tools/", import.meta.url);
const sources = async () =>
  Promise.all(
    (await readdir(toolsDir)).filter((f) => f.endsWith(".ts")).map(async (f) => ({ f, text: await readFile(new URL(f, toolsDir), "utf8") })),
  );

test("no tool can write, delete, move or execute anything", async () => {
  const forbidden =
    /\b(writeFile|appendFile|createWriteStream|rename|rm|rmdir|unlink|mkdir|copyFile|cp|chmod|chown|truncate|symlink|link|utimes|open)\s*\(|node:child_process|node:worker_threads|node:vm|\bspawn\b|\bexecFile\b|\bexec\s*\(|\beval\s*\(|new Function\b/;
  const files = await sources();
  assert.ok(files.length >= 6, "found the tool sources");
  for (const { f, text } of files) {
    const hit = text.split("\n").findIndex((line) => forbidden.test(line));
    assert.equal(hit, -1, `src/tools/${f}:${hit + 1} uses a write or exec API: ${text.split("\n")[hit]?.trim()}`);
  }
});

test("no tool can reach the code that saves settings, the policy or transcripts", async () => {
  const writers = /from "\.\.\/(settings|defaults_command|policy_command|log|model_command|turns_command)\.ts"/;
  for (const { f, text } of await sources()) {
    assert.doesNotMatch(text, writers, `src/tools/${f} imports a module that writes settings or logs`);
  }
});
