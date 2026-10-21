import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir } from "node:os";
import { libraryPaths } from "../src/library/paths.ts";

test("the default root is ~/.harness/library", () => {
  const p = libraryPaths({});
  assert.ok(p.root.endsWith(join(".harness", "library")), p.root);
  assert.equal(p.root, join(homedir(), ".harness", "library"));
});

test("HARNESS_LIBRARY_ROOT sets the root and the subpaths join under it", () => {
  const p = libraryPaths({ HARNESS_LIBRARY_ROOT: "/x" });
  assert.equal(p.root, "/x");
  assert.equal(p.toolsDir, join("/x", "tools"));
  assert.equal(p.skillsDir, join("/x", "skills"));
  assert.equal(p.manifestPath, join("/x", "manifest.json"));
});
