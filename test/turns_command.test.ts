import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurnsCommand } from "../src/turns_command.ts";

test("/turns shows the current limit", () => {
  assert.deepEqual(runTurnsCommand("", 10), {
    output: "Max turns: 10 model call(s) per message. /turns <n> or /turns unlimited to change it for this session.",
  });
  assert.match(runTurnsCommand("", Infinity).output, /^Max turns: unlimited \(press Ctrl\+C to stop a run\)\./);
});

test("/turns <n> sets a new limit", () => {
  const r = runTurnsCommand(" 25 ", 10);
  assert.equal(r.maxTurns, 25);
  assert.match(r.output, /^Max turns: 25 model call\(s\) per message \(was 10 model call\(s\)\)\. Lasts for this session/);
  assert.deepEqual(runTurnsCommand("10", 10), { output: "Max turns is already 10 model call(s)." });
});

test("/turns unlimited (or off) removes the limit, and a number brings it back", () => {
  for (const arg of ["unlimited", "Unlimited", "off"]) {
    const r = runTurnsCommand(arg, 10);
    assert.equal(r.maxTurns, Infinity, arg);
    assert.match(r.output, /^Max turns: unlimited \(press Ctrl\+C to stop a run\) \(was 10 model call\(s\)\)/, arg);
  }
  assert.deepEqual(runTurnsCommand("unlimited", Infinity), { output: "Max turns is already unlimited." });
  assert.equal(runTurnsCommand("8", Infinity).maxTurns, 8);
});

test("anything else changes nothing", () => {
  for (const arg of ["0", "-3", "2.5", "lots", "1e3", "5 6", "99999999999999999999", "infinity"]) {
    const r = runTurnsCommand(arg, 10);
    assert.equal(r.maxTurns, undefined, arg);
    assert.match(r.output, /^Not changed: \/turns needs a whole number of 1 or more, or "unlimited"/, arg);
  }
});
