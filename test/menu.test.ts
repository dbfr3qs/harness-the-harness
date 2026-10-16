import { test } from "node:test";
import assert from "node:assert/strict";
import { menuKey, renderMenu } from "../src/menu.ts";
import type { MenuItem } from "../src/menu.ts";

const items: MenuItem<string>[] = [
  { label: "a", value: "a" },
  { label: "b", value: "b", disabled: "no key" },
  { label: "c", value: "c", hint: "current" },
];

test("arrows and j/k move the cursor, wrap around and skip disabled items", () => {
  assert.deepEqual(menuKey(items, { index: 0 }, { name: "down" }), { index: 2 });
  assert.deepEqual(menuKey(items, { index: 2 }, { name: "down" }), { index: 0 }, "wraps");
  assert.deepEqual(menuKey(items, { index: 0 }, { name: "up" }), { index: 2 });
  assert.deepEqual(menuKey(items, { index: 2 }, { name: "k" }), { index: 0 });
  assert.deepEqual(menuKey(items, { index: 0 }, { name: "x", sequence: "x" }), { index: 0 }, "other keys do nothing");
});

test("Enter and number keys select; disabled items can't be selected; Esc, q and Ctrl+C cancel", () => {
  assert.deepEqual(menuKey(items, { index: 2 }, { name: "return" }), { index: 2, done: "select" });
  assert.deepEqual(menuKey(items, { index: 1 }, { name: "return" }), { index: 1 });
  assert.deepEqual(menuKey(items, { index: 0 }, { name: "3", sequence: "3" }), { index: 2, done: "select" });
  assert.deepEqual(menuKey(items, { index: 0 }, { name: "2", sequence: "2" }), { index: 0 });
  assert.deepEqual(menuKey(items, { index: 0 }, { name: "9", sequence: "9" }), { index: 0 });
  for (const key of [{ name: "escape" }, { name: "q" }, { name: "c", ctrl: true }]) {
    assert.equal(menuKey(items, { index: 0 }, key).done, "cancel", JSON.stringify(key));
  }
});

test("render marks the cursor, numbers items and shows hints or the disabled reason", () => {
  assert.deepEqual(renderMenu("Pick", items, 2, false), [
    "Pick (↑/↓ or 1-3, Enter to choose, Esc to cancel)",
    "  1. a",
    "  2. b  no key",
    "❯ 3. c  current",
  ]);
});
