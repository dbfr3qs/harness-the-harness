import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
  await writeFile(join(root, ".env"), "ANTHROPIC_API_KEY=sk-ant-SECRET\n");
  await writeFile(join(root, ".env.local"), "TOKEN=SECRET\n");
  await writeFile(join(root, "src", ".env"), "TOKEN=SECRET\n");
  await symlink(join(root, ".env"), join(root, "innocent.txt"));
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
    ".env", ".env.local", "big.txt", "binary.bin", "empty/", "exact.txt", "hello.txt", "innocent.txt", "many/", "src/",
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

test("read_file never reads .env files, however the path is spelled", async () => {
  const paths = [
    ".env", "./.env", "src/../.env", ".ENV", ".env.local", "src/.env",
    join(root, ".env"), // absolute path inside the workspace
    "innocent.txt", // symlink to .env
  ];
  for (const path of paths) {
    const out = await registry.dispatch("read_file", { path });
    assert.equal(out.isError, true, path);
    assert.match(out.content, /^Error: .* is an environment file \(\.env\)/, path);
    assert.ok(!out.content.includes("SECRET"), `secret leaked for ${path}`);
  }
});

test("names that merely contain 'env' are still readable", async () => {
  await writeFile(join(root, "env.txt"), "fine");
  await writeFile(join(root, "my.env.txt"), "fine");
  for (const path of ["env.txt", "my.env.txt"]) {
    assert.deepEqual(await registry.dispatch("read_file", { path }), { content: "fine", isError: false });
  }
});

// --- private paths ----------------------------------------------------------

test(".git and the transcript directory can't be read or listed, however the path is spelled", async () => {
  const ws = await realpath(await mkdtemp(join(tmpdir(), "harness-private-")));
  try {
    await mkdir(join(ws, ".git"));
    await writeFile(join(ws, ".git", "config"), "[user]\n\temail = someone@example.test\n");
    await mkdir(join(ws, "vendor", "lib", ".git"), { recursive: true });
    await writeFile(join(ws, "vendor", "lib", ".git", "HEAD"), "ref");
    await mkdir(join(ws, "logs"));
    await writeFile(join(ws, "logs", "old.jsonl"), '{"kind":"request","data":"PAST CONVERSATION"}');
    await mkdir(join(ws, "src"));
    await writeFile(join(ws, "src", "ok.ts"), "fine");
    await symlink(join(ws, "logs"), join(ws, "shortcut"));
    await symlink(join(ws, ".git", "config"), join(ws, "gitconfig"));

    const privatePaths = [{ path: "logs", name: "logs/", holds: "conversation transcripts" }];
    const reg = createRegistry([createListDirTool(ws, privatePaths), createReadFileTool(ws, privatePaths)]);

    for (const path of [".git/config", "./.git/config", ".GIT/config", "src/../.git/config", join(ws, ".git", "config"), "gitconfig", "vendor/lib/.git/HEAD"]) {
      const out = await reg.dispatch("read_file", { path });
      assert.equal(out.isError, true, path);
      assert.match(out.content, /\.git\/, which holds the repository's internal data\. The harness keeps it private/i, path);
      assert.ok(!out.content.includes("someone@"), path);
    }
    for (const path of ["logs/old.jsonl", "shortcut/old.jsonl", "src/../logs/old.jsonl"]) {
      const out = await reg.dispatch("read_file", { path });
      assert.match(out.content, /^Error: ".*" is off limits: it is in logs\/, which holds conversation transcripts\. The harness keeps it private, so read_file will not read it/, path);
      assert.ok(!out.content.includes("PAST CONVERSATION"), path);
    }
    // A private file (not a directory) is named as itself.
    const settingsReg = createRegistry([createReadFileTool(ws, [{ path: "src/ok.ts", name: "src/ok.ts", holds: "test settings" }])]);
    assert.match((await settingsReg.dispatch("read_file", { path: "src/ok.ts" })).content, /^Error: "src\/ok\.ts" is off limits: src\/ok\.ts holds test settings\. The harness keeps it private/);

    for (const path of [".git", "logs", "shortcut", "vendor/lib/.git"]) {
      const out = await reg.dispatch("list_dir", { path });
      assert.match(out.content, /^Error: .* The harness keeps it private, so list_dir will not list it/, path);
    }

    // Listings leave private entries out and say so; everything else is unaffected.
    assert.deepEqual(await reg.dispatch("list_dir", {}), {
      content: "src/\nvendor/\n[not listed: .git/, gitconfig, logs/, shortcut (kept private by the harness)]",
      isError: false,
    });
    assert.equal((await reg.dispatch("list_dir", { path: "vendor/lib" })).content, "(empty directory)\n[not listed: .git/ (kept private by the harness)]");
    assert.deepEqual(await reg.dispatch("read_file", { path: "src/ok.ts" }), { content: "fine", isError: false });
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("names that only resemble .git are readable", async () => {
  await writeFile(join(root, ".gitignore"), "node_modules/\n");
  await writeFile(join(root, "my.git"), "fine");
  assert.equal((await registry.dispatch("read_file", { path: ".gitignore" })).isError, false);
  assert.equal((await registry.dispatch("read_file", { path: "my.git" })).isError, false);
});
