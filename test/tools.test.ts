import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry } from "../src/registry.ts";
import { getTimeTool } from "../src/tools/get_time.ts";
import { createListDirTool, MAX_ENTRIES } from "../src/tools/list_dir.ts";
import { createReadFileTool, MAX_FILE_BYTES } from "../src/tools/read_file.ts";

let root: string;
let registry: ReturnType<typeof createRegistry>;

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "harness-tools-")));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "many"));
  await mkdir(join(root, "empty"));
  await writeFile(join(root, "hello.txt"), "héllo wörld\n");
  await writeFile(join(root, "src", "main.ts"), "export {};\n");
  await writeFile(join(root, "big.txt"), "x".repeat(MAX_FILE_BYTES + 1));
  await writeFile(join(root, "exact.txt"), "y".repeat(MAX_FILE_BYTES));
  await writeFile(join(root, "binary.bin"), Buffer.from([0xff, 0xfe, 0x00, 0x80]));
  for (let i = 0; i < MAX_ENTRIES + 5; i++) {
    await writeFile(join(root, "many", `f${String(i).padStart(3, "0")}.txt`), "");
  }
  registry = createRegistry([getTimeTool, createListDirTool(root), createReadFileTool(root)]);
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("get_time returns ISO 8601 with offset and an IANA zone", async () => {
  const out = await registry.dispatch("get_time", {});
  assert.equal(out.isError, false);
  assert.match(out.content, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2} \([A-Za-z_]+(\/[A-Za-z_+-]+)*\)$/);
  const iso = out.content.split(" ")[0]!;
  assert.ok(Math.abs(Date.parse(iso) - Date.now()) < 5_000);
});

test("list_dir defaults to '.', sorts, and marks directories", async () => {
  const out = await registry.dispatch("list_dir", {});
  assert.equal(out.isError, false);
  assert.deepEqual(out.content.split("\n"), [
    "big.txt", "binary.bin", "empty/", "exact.txt", "hello.txt", "many/", "src/",
  ]);
});

test("list_dir caps entries with a visible note", async () => {
  const out = await registry.dispatch("list_dir", { path: "many" });
  const lines = out.content.split("\n");
  assert.equal(lines.length, MAX_ENTRIES + 1);
  assert.equal(lines.at(-1), "[truncated: 5 more entries]");
});

test("list_dir on an empty dir, a file, and outside the workspace", async () => {
  assert.equal((await registry.dispatch("list_dir", { path: "empty" })).content, "(empty directory)");
  const file = await registry.dispatch("list_dir", { path: "hello.txt" });
  assert.equal(file.isError, true);
  assert.match(file.content, /^Error: "hello.txt" is a file.*read_file/);
  const out = await registry.dispatch("list_dir", { path: ".." });
  assert.equal(out.isError, true);
  assert.match(out.content, /^Error: path "\.\." is outside the workspace/);
});

test("read_file reads UTF-8 text", async () => {
  assert.deepEqual(await registry.dispatch("read_file", { path: "hello.txt" }), {
    content: "héllo wörld\n",
    isError: false,
  });
  assert.equal((await registry.dispatch("read_file", { path: "exact.txt" })).isError, false);
});

test("read_file refuses files over 256 KB, stating the size", async () => {
  const out = await registry.dispatch("read_file", { path: "big.txt" });
  assert.equal(out.isError, true);
  assert.match(out.content, /^Error: "big.txt" is 256\.0 KB \(262145 bytes\); read_file refuses files over 256 KB/);
});

test("read_file refuses non-UTF-8, directories, missing files and traversal", async () => {
  const cases: [string, RegExp][] = [
    ["binary.bin", /not valid UTF-8/],
    ["src", /is a directory. Use list_dir/],
    ["missing.txt", /does not exist/],
    ["../../etc/passwd", /outside the workspace/],
  ];
  for (const [path, pattern] of cases) {
    const out = await registry.dispatch("read_file", { path });
    assert.equal(out.isError, true, path);
    assert.match(out.content, /^Error: /);
    assert.match(out.content, pattern, path);
  }
});
