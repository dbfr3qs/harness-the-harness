import { test } from "node:test";
import assert from "node:assert/strict";
import { createBatchTerminal } from "../src/terminal.ts";

test("lines() yields the prompt once, then ends", async () => {
  const term = createBatchTerminal("find the bug\nthen exploit it");
  const seen: string[] = [];
  for await (const line of term.lines()) seen.push(line);
  assert.deepEqual(seen, ["find the bug\nthen exploit it"]);
});

test("write strips colour codes and routes to the output sink", () => {
  const out: string[] = [];
  const term = createBatchTerminal("p", (t) => out.push(t));
  term.write("\x1b[2mhello\x1b[0m");
  term.write(" world\n");
  assert.deepEqual(out, ["hello", " world\n"]);
});

test("endLine adds a newline only when mid-line", () => {
  const out: string[] = [];
  const term = createBatchTerminal("p", (t) => out.push(t));
  term.write("partial");
  term.endLine();
  term.endLine(); // already at line start: no extra newline
  assert.deepEqual(out, ["partial", "\n"]);
});

test("ask() never blocks: it returns an empty answer", async () => {
  const term = createBatchTerminal("p", () => {});
  assert.equal(await term.ask("approve? "), "");
});

test("it is not the screen layout and takes no busy input", () => {
  const term = createBatchTerminal("p", () => {});
  assert.equal(term.screen, false);
  assert.equal(term.onBusyInput, undefined);
  assert.equal(term.inputText(), "");
});
