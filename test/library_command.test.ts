import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDiff, formatInventory, parseLibraryCommand } from "../src/library_command.ts";
import type { InventoryItem, LibraryDiff } from "../src/library_command.ts";

test("/tools with no argument parses to a list of tools", () => {
  assert.deepEqual(parseLibraryCommand("/tools"), { type: "list", kind: "tool" });
});

test("/skills and /mcp with no argument list their own kind", () => {
  assert.deepEqual(parseLibraryCommand("/skills"), { type: "list", kind: "skill" });
  assert.deepEqual(parseLibraryCommand("/mcp"), { type: "list", kind: "mcp" });
});

test("extra whitespace does not change a bare list command", () => {
  assert.deepEqual(parseLibraryCommand("  /tools   "), { type: "list", kind: "tool" });
});

test("/mcp disable foo parses to a disable of kind mcp", () => {
  assert.deepEqual(parseLibraryCommand("/mcp disable foo"), { type: "disable", kind: "mcp", name: "foo" });
});

test("/tools enable <name> parses to an enable of kind tool", () => {
  assert.deepEqual(parseLibraryCommand("/tools enable my_tool"), { type: "enable", kind: "tool", name: "my_tool" });
});

test("/skills enable <name> toggles a skill", () => {
  assert.deepEqual(parseLibraryCommand("/skills enable writing"), { type: "enable", kind: "skill", name: "writing" });
});

test("/library with no argument asks to review the session diff", () => {
  assert.deepEqual(parseLibraryCommand("/library"), { type: "persist-review" });
});

test("/library persist parses to a persist action", () => {
  assert.deepEqual(parseLibraryCommand("/library persist"), { type: "persist" });
});

test("an unknown subcommand is an instructive error", () => {
  const action = parseLibraryCommand("/tools frobnicate");
  assert.equal(action.type, "error");
  if (action.type !== "error") return;
  assert.match(action.message, /frobnicate/);
  assert.match(action.message, /\/tools/); // the help text is included
});

test("an unknown /library subcommand is an instructive error", () => {
  const action = parseLibraryCommand("/library wibble");
  assert.equal(action.type, "error");
  if (action.type !== "error") return;
  assert.match(action.message, /wibble/);
});

test("enable/disable with no name is an instructive error", () => {
  const action = parseLibraryCommand("/mcp enable");
  assert.equal(action.type, "error");
  if (action.type !== "error") return;
  assert.match(action.message, /Usage/);
});

test("enable/disable with extra arguments is an instructive error", () => {
  assert.equal(parseLibraryCommand("/tools enable a b").type, "error");
});

test("a command that is not a library command is an instructive error", () => {
  assert.equal(parseLibraryCommand("/policy show").type, "error");
});

test("formatInventory shows loaded vs not-loaded, origin, and description", () => {
  const items: InventoryItem[] = [
    { kind: "tool", name: "saved_on", enabled: true, persisted: true, description: "does a thing" },
    { kind: "mcp", name: "fresh_off", enabled: false, persisted: false },
  ];
  const out = formatInventory(items);
  const [first, second] = out.split("\n");
  assert.match(first!, /saved_on/);
  assert.match(first!, /\bloaded\b/);
  assert.doesNotMatch(first!, /not loaded/);
  assert.match(first!, /does a thing/);
  assert.match(first!, /persisted/);
  assert.doesNotMatch(first!, /session-only/);
  assert.match(second!, /fresh_off/);
  assert.match(second!, /not loaded/);
  assert.match(second!, /session-only/);
});

test("formatInventory handles an empty library", () => {
  assert.match(formatInventory([]), /[Nn]othing/);
});

test("formatDiff lists added items and mentions no enabled/disabled change", () => {
  const out = formatDiff({ added: [{ kind: "mcp", name: "rea" }] });
  assert.match(out, /rea/);
  assert.doesNotMatch(out, /enabled|disabled/);
});

test("formatDiff reports an empty diff plainly", () => {
  assert.match(formatDiff({ added: [] }), /[Nn]o unpersisted/);
});
