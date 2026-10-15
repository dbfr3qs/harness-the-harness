import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInWorkspace } from "../src/tools/workspace.ts";

// Layout:
//   <base>/root/a.txt, ..odd.txt, sub/b.txt
//   <base>/root/link-in      -> root/a.txt         (stays inside)
//   <base>/root/link-out     -> outside/secret.txt (escapes)
//   <base>/root/linkdir-out  -> outside/           (escapes)
//   <base>/root-sibling/x.txt                       (shares the root's name prefix)
//   <base>/outside/secret.txt
let base: string;
let root: string;

before(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "harness-ws-")));
  root = join(base, "root");
  await mkdir(join(root, "sub"), { recursive: true });
  await mkdir(join(base, "outside"));
  await mkdir(join(base, "root-sibling"));
  await writeFile(join(root, "a.txt"), "a");
  await writeFile(join(root, "..odd.txt"), "odd");
  await writeFile(join(root, "sub", "b.txt"), "b");
  await writeFile(join(base, "outside", "secret.txt"), "secret");
  await writeFile(join(base, "root-sibling", "x.txt"), "x");
  await symlink(join(root, "a.txt"), join(root, "link-in"));
  await symlink(join(base, "outside", "secret.txt"), join(root, "link-out"));
  await symlink(join(base, "outside"), join(root, "linkdir-out"));
});

after(async () => {
  await rm(base, { recursive: true, force: true });
});

const OUTSIDE = /is outside the workspace/;

test("resolves paths inside the workspace", async () => {
  assert.equal(await resolveInWorkspace(root, "."), root);
  assert.equal(await resolveInWorkspace(root, ""), root);
  assert.equal(await resolveInWorkspace(root, "a.txt"), join(root, "a.txt"));
  assert.equal(await resolveInWorkspace(root, "sub/b.txt"), join(root, "sub", "b.txt"));
  assert.equal(await resolveInWorkspace(root, "./sub/../a.txt"), join(root, "a.txt"));
  assert.equal(await resolveInWorkspace(root, join(root, "a.txt")), join(root, "a.txt"));
});

test("a file name starting with '..' is not mistaken for traversal", async () => {
  assert.equal(await resolveInWorkspace(root, "..odd.txt"), join(root, "..odd.txt"));
});

test("a symlink that stays inside is allowed and resolved", async () => {
  assert.equal(await resolveInWorkspace(root, "link-in"), join(root, "a.txt"));
});

test("rejects .. traversal", async () => {
  for (const p of ["..", "../outside/secret.txt", "sub/../../outside/secret.txt", "../../../../etc/passwd"]) {
    await assert.rejects(resolveInWorkspace(root, p), OUTSIDE, p);
  }
});

test("rejects absolute paths elsewhere", async () => {
  for (const p of ["/etc/passwd", join(base, "outside", "secret.txt"), base]) {
    await assert.rejects(resolveInWorkspace(root, p), OUTSIDE, p);
  }
});

test("rejects a sibling directory that shares the root's name prefix", async () => {
  await assert.rejects(resolveInWorkspace(root, "../root-sibling/x.txt"), OUTSIDE);
  await assert.rejects(resolveInWorkspace(root, join(base, "root-sibling", "x.txt")), OUTSIDE);
});

test("rejects symlinks that escape, to a file or through a directory", async () => {
  await assert.rejects(resolveInWorkspace(root, "link-out"), OUTSIDE);
  await assert.rejects(resolveInWorkspace(root, "linkdir-out/secret.txt"), OUTSIDE);
  await assert.rejects(resolveInWorkspace(root, "linkdir-out"), OUTSIDE);
});

test("missing paths get an instructive not-found error", async () => {
  await assert.rejects(resolveInWorkspace(root, "nope.txt"), /"nope.txt" does not exist. Use list_dir/);
});
