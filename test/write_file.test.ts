import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWriteFileTool } from "../src/tools/unattended/write_file.ts";
import type { PrivatePath } from "../src/tools/private_paths.ts";

const ctx = { signal: new AbortController().signal };
const write = (root: string, path: string, content: string, priv: PrivatePath[] = []) =>
  createWriteFileTool(root, priv).handler({ path, content }, ctx);

test("creates a new file, making parent directories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "write-"));
  const msg = await write(dir, "a/b/c.txt", "hi");
  assert.match(msg, /Wrote 2 byte\(s\) to a\/b\/c\.txt/);
  assert.equal(await readFile(join(dir, "a/b/c.txt"), "utf8"), "hi");
});

test("overwrites an existing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "write-"));
  await writeFile(join(dir, "f.txt"), "old");
  await write(dir, "f.txt", "new");
  assert.equal(await readFile(join(dir, "f.txt"), "utf8"), "new");
});

test("refuses .env files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "write-"));
  await assert.rejects(write(dir, ".env", "KEY=1"), /environment file/);
  await assert.rejects(write(dir, ".env.local", "KEY=1"), /environment file/);
});

test("refuses paths outside the workspace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "write-"));
  await assert.rejects(write(dir, "../escape.txt", "x"), /outside the workspace/);
  await assert.rejects(write(dir, "/etc/passwd", "x"), /outside the workspace/);
});

test("refuses the workspace root itself", async () => {
  const dir = await mkdtemp(join(tmpdir(), "write-"));
  await assert.rejects(write(dir, ".", "x"), /workspace root/);
});

test("refuses private paths such as the harness's settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "write-"));
  const priv: PrivatePath[] = [{ path: "harness.json", name: "harness.json", holds: "the harness's saved settings" }];
  await assert.rejects(write(dir, "harness.json", "{}", priv), /off limits/);
});
