import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunShellTool } from "../src/tools/unattended/run_shell.ts";

const noSignal = () => new AbortController().signal;
const run = (cwd: string, command: string, opts = {}, signal = noSignal()) =>
  createRunShellTool(cwd, opts).handler({ command }, { signal });

test("runs a command and returns stdout with the exit code", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shell-"));
  const out = await run(dir, "echo hello");
  assert.match(out, /^\[exit code 0\]/);
  assert.match(out, /hello/);
});

test("captures stderr and a non-zero exit code", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shell-"));
  const out = await run(dir, "echo oops >&2; exit 3");
  assert.match(out, /\[exit code 3\]/);
  assert.match(out, /oops/);
});

test("runs in the workspace directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shell-"));
  const out = await run(dir, "pwd");
  // macOS /tmp is a symlink to /private/tmp, so compare the real path the shell reports.
  assert.match(out.split("\n")[1] ?? "", /shell-/);
});

test("kills a command that runs past the timeout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shell-"));
  const out = await run(dir, "sleep 5", { timeoutMs: 150 });
  assert.match(out, /killed after the 0\.15 s timeout/);
});

test("truncates output past the cap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shell-"));
  const out = await run(dir, "printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'", { maxOutputBytes: 10 });
  assert.match(out, /output truncated/);
  assert.ok((out.split("\n")[1] ?? "").length <= 10);
});

test("stops when the run is interrupted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shell-"));
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const out = await run(dir, "sleep 5", {}, controller.signal);
  assert.match(out, /interrupted by the user/);
});

test("a command can write a file in the workspace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shell-"));
  await run(dir, "echo data > made.txt");
  assert.equal((await readFile(join(dir, "made.txt"), "utf8")).trim(), "data");
});
