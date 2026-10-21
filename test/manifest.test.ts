import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../src/config.ts";
import { formatManifest, loadManifest, parseManifest, saveManifest } from "../src/library/manifest.ts";
import type { Manifest } from "../src/library/manifest.ts";

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-manifest-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sample: Manifest = {
  entries: [
    { kind: "tool", name: "word_count", file: "word_count.ts", enabled: true },
    { kind: "skill", name: "triage", description: "Triage bug reports", enabled: false },
    { kind: "mcp", name: "files", server: { name: "files", command: "node", args: ["srv.js"], interactive: false, tools: ["read*"] }, enabled: true },
  ],
};

test("a manifest of each kind round-trips through its text", () => {
  const text = formatManifest(sample);
  assert.ok(text.endsWith("\n"));
  assert.deepEqual(parseManifest(JSON.parse(text), "m.json"), sample);
});

test("an unknown top-level key is a ConfigError", () => {
  assert.throws(() => parseManifest({ entries: [], extra: 1 }, "m.json"), ConfigError);
});

test("an entry with an unknown kind is a ConfigError", () => {
  assert.throws(() => parseManifest({ entries: [{ kind: "widget", name: "x", enabled: true }] }, "m.json"), /kind/);
});

test("an mcp entry with a bad server is rejected by the shared MCP rules", () => {
  assert.throws(
    () => parseManifest({ entries: [{ kind: "mcp", name: "files", server: {}, enabled: true }] }, "m.json"),
    (err: Error) => err instanceof ConfigError && /command/.test(err.message),
  );
});

test("loading a missing manifest gives an empty one", async () => {
  assert.deepEqual(await loadManifest(join(dir, "none", "m.json")), { entries: [] });
});

test("a broken manifest file is a ConfigError", async () => {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(dir, "bad.json"), "{nope", "utf8");
  await assert.rejects(loadManifest(join(dir, "bad.json")), ConfigError);
});

test("save then load returns equal entries, creating the directory and leaving no temp file", async () => {
  const path = join(dir, "sub", "m.json");
  await saveManifest(path, sample);
  assert.deepEqual(await loadManifest(path), sample);
  assert.equal(await readFile(path, "utf8"), formatManifest(sample));
  assert.deepEqual(await readdir(join(dir, "sub")), ["m.json"]);
});
