import { test } from "node:test";
import assert from "node:assert/strict";
import { turnRule } from "../src/turn_marks.ts";
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
test("turnRule is a dim rule of the given width", () => {
  assert.equal(strip(turnRule(5)), "─────");
  assert.match(turnRule(5), /^\x1b\[2m/);
  assert.ok(turnRule(5).endsWith("\x1b[0m"));
});
test("turnRule clamps to at least one cell", () => {
  assert.equal(strip(turnRule(0)), "─");
});
