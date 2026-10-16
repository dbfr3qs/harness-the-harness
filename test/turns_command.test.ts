import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurnsCommand } from "../src/turns_command.ts";

test("/turns shows the current limit", () => {
  assert.deepEqual(runTurnsCommand("", 10), {
    output: "Max turns: 10 model call(s) per message. /turns <n> to change it for this session.",
  });
});

test("/turns <n> sets a new limit", () => {
  const r = runTurnsCommand(" 25 ", 10);
  assert.equal(r.maxTurns, 25);
  assert.match(r.output, /^Max turns: 25 model call\(s\) per message \(was 10\)\. Lasts for this session/);
  assert.deepEqual(runTurnsCommand("10", 10), { output: "Max turns is already 10." });
});

test("anything but a whole number of 1 or more changes nothing", () => {
  for (const arg of ["0", "-3", "2.5", "lots", "1e3", "5 6", "99999999999999999999"]) {
    const r = runTurnsCommand(arg, 10);
    assert.equal(r.maxTurns, undefined, arg);
    assert.match(r.output, /^Not changed: \/turns needs a whole number of 1 or more/, arg);
  }
});
