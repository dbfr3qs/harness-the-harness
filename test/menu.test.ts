import { test } from "node:test";
import assert from "node:assert/strict";
import { appliedToggles, menuKey, menuViewport, renderMenu } from "../src/menu.ts";
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
  assert.deepEqual(renderMenu("Pick", items, 2, { color: false }), [
    "Pick",
    "  1. a",
    "  2. b  no key",
    "❯ 3. c  current",
  ]);
});

const tItems: MenuItem<string>[] = [
  { label: "x", value: "x", on: true },
  { label: "y", value: "y", on: false },
  { label: "z", value: "z", on: false },
];

test("toggle mode: Space flips the current item and keeps the menu open", () => {
  const a = menuKey(tItems, { index: 1 }, { name: "space", sequence: " " }, { toggle: true });
  assert.equal(a.done, undefined);
  assert.ok(a.toggled?.has(1));
  const b = menuKey(tItems, a, { sequence: " " }, { toggle: true });
  assert.equal(b.toggled?.has(1), false);
  assert.equal(b.done, undefined);
});

test("toggle mode: digits don't finish, Enter does, movement keeps toggled", () => {
  const s = { index: 0, toggled: new Set([2]) };
  assert.equal(menuKey(tItems, s, { name: "2", sequence: "2" }, { toggle: true }).done, undefined);
  assert.equal(menuKey(tItems, s, { name: "return" }, { toggle: true }).done, "select");
  assert.ok(menuKey(tItems, s, { name: "down" }, { toggle: true }).toggled?.has(2));
  assert.ok(menuKey(tItems, s, { name: "up" }, { toggle: true }).toggled?.has(2));
});

test("select mode ignores Space; digits still finish", () => {
  assert.deepEqual(menuKey(items, { index: 0 }, { name: "space", sequence: " " }), { index: 0 });
  assert.equal(menuKey(items, { index: 0 }, { name: "3", sequence: "3" }).done, "select");
});

test("appliedToggles reports the new effective state in index order", () => {
  assert.deepEqual(appliedToggles(tItems, { index: 0, toggled: new Set([1]) }), [{ value: "y", on: true }]);
  assert.deepEqual(appliedToggles(tItems, { index: 0, toggled: new Set([2, 0]) }), [
    { value: "x", on: false },
    { value: "z", on: true },
  ]);
  assert.deepEqual(appliedToggles(tItems, { index: 0 }), []);
});

test("menuViewport keeps the index visible within maxRows", () => {
  assert.deepEqual(menuViewport(20, 0, 5), { start: 0, end: 5 });
  const v = menuViewport(20, 18, 5);
  assert.ok(v.start <= 18 && 18 < v.end && v.end - v.start <= 5);
  assert.deepEqual(menuViewport(3, 0, 10), { start: 0, end: 3 });
});

test("renderMenu toggle mode draws bullets, pending state, footer and viewport markers", () => {
  const lines = renderMenu("T", tItems, 0, { color: false, toggle: true, toggled: new Set([1]), footer: "Space toggles" });
  assert.equal(lines[0], "T");
  assert.ok(lines[1]!.includes("● x"));
  assert.ok(lines[2]!.includes("● y"), "flipped item shows pending state");
  assert.ok(lines[3]!.includes("○ z"));
  assert.equal(lines.at(-1), "Space toggles");
  assert.ok(!lines.join("\n").includes("Enter to choose"));
  const many = Array.from({ length: 20 }, (_, i) => ({ label: `i${i}`, value: i }));
  const v = renderMenu("T", many, 10, { color: false, maxRows: 5 });
  assert.ok(v.some((l) => l.includes("more")));
  assert.ok(v.some((l) => l.includes("i10")));
});

test("renderMenu with no items doesn't throw", () => {
  assert.deepEqual(renderMenu("Empty", [], 0, { color: false }), ["Empty"]);
});

test("selectFromMenu draws the select key-hint footer", async () => {
  const { EventEmitter } = await import("node:events");
  const { selectFromMenu } = await import("../src/menu.ts");
  const input = new EventEmitter() as unknown as NodeJS.ReadStream;
  let written = "";
  const output = { write: (s: string) => ((written += s), true) } as unknown as NodeJS.WriteStream;
  const p = selectFromMenu(input, output, "Pick", [{ label: "a", value: 1 }, { label: "b", value: 2 }], 0);
  assert.ok(written.includes("↑/↓ move · enter select · esc cancel"), written);
  input.emit("keypress", undefined, { name: "escape" });
  assert.equal(await p, undefined);
});
