import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry, defineTool } from "../src/registry.ts";

const echo = defineTool({
  name: "echo",
  description: "Echo the text back.",
  input_schema: {
    type: "object",
    properties: {
      text: { type: "string" },
      times: { type: "integer" },
      loud: { type: "boolean" },
      scale: { type: "number" },
      mode: { type: "string", enum: ["plain", "fancy"] },
    },
    required: ["text"],
  },
  handler: async (input) => String(input.text).repeat(Number(input.times ?? 1)),
});

const boom = defineTool({
  name: "boom",
  description: "Always fails.",
  input_schema: { type: "object", properties: {} },
  handler: async () => {
    throw new Error("disk on fire; try again later");
  },
});

const registry = createRegistry([echo, boom]);

test("definitions are Claude-format with no handler", () => {
  const defs = registry.definitions();
  assert.equal(defs.length, 2);
  assert.deepEqual(Object.keys(defs[0]!).sort(), ["description", "input_schema", "name"]);
  assert.equal(defs[0]!.name, "echo");
});

test("success runs the handler", async () => {
  const out = await registry.dispatch("echo", { text: "ab", times: 2 });
  assert.deepEqual(out, { content: "abab", isError: false });
});

test("unknown tool lists the valid names", async () => {
  const out = await registry.dispatch("nope", {});
  assert.equal(out.isError, true);
  assert.match(out.content, /^Error: unknown tool "nope"/);
  assert.match(out.content, /echo, boom/);
});

for (const [label, input, got] of [
  ["null", null, "null"],
  ["array", ["text"], "array"],
  ["string", "hello", "string"],
] as const) {
  test(`non-object input (${label}) is an error`, async () => {
    const out = await registry.dispatch("echo", input);
    assert.equal(out.isError, true);
    assert.match(out.content, /^Error: input for "echo" must be a JSON object/);
    assert.match(out.content, new RegExp(`got ${got}`));
  });
}

test("missing required key names the key", async () => {
  const out = await registry.dispatch("echo", { times: 2 });
  assert.equal(out.isError, true);
  assert.match(out.content, /^Error: missing required key\(s\) for "echo": text/);
});

for (const [key, value, pattern] of [
  ["text", 42, /"text" must be a string, got number/],
  ["times", 1.5, /"times" must be an integer, got 1.5/],
  ["times", "2", /"times" must be an integer, got string/],
  ["loud", "yes", /"loud" must be a boolean, got string/],
  ["scale", "big", /"scale" must be a number, got string/],
  ["mode", "weird", /"mode" must be one of "plain", "fancy"/],
] as const) {
  test(`wrong type for ${key} (${JSON.stringify(value)}) is an error`, async () => {
    const input = { text: "x", [key]: value };
    const out = await registry.dispatch("echo", input);
    assert.equal(out.isError, true);
    assert.match(out.content, /^Error: /);
    assert.match(out.content, pattern);
  });
}

test("unknown keys are rejected, naming the valid ones, and the handler doesn't run", async () => {
  let ran = false;
  const reader = defineTool({
    name: "reader",
    description: "Reads.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    handler: async () => {
      ran = true;
      return "contents";
    },
  });
  const out = await createRegistry([reader]).dispatch("reader", { path: "a.txt", offset: 250 });
  assert.deepEqual(out, {
    content: 'Error: unknown key(s) for "reader": offset. "reader" takes only: path. Call it again without it.',
    isError: true,
  });
  assert.equal(ran, false);
  const none = await registry.dispatch("boom", { x: 1, y: 2 });
  assert.match(none.content, /unknown key\(s\) for "boom": x, y\. "boom" takes only: none\. Call it again without them\./);
});

test("handler exception becomes an error result", async () => {
  const out = await registry.dispatch("boom", {});
  assert.deepEqual(out, { content: "Error: disk on fire; try again later", isError: true });
});

test("duplicate tool names throw at creation", () => {
  assert.throws(() => createRegistry([echo, echo]), /Duplicate tool name "echo"/);
});

test("invalid tool names throw at creation", () => {
  for (const name of ["", "has space", "dot.name", "x".repeat(129)]) {
    assert.throws(() => createRegistry([{ ...echo, name }]), /Invalid tool name/);
  }
});

test("unparseable input from the client (_invalidJson) is an error, even with no required keys", async () => {
  const out = await registry.dispatch("boom", { _invalidJson: '{"path": "pack' });
  assert.equal(out.isError, true);
  assert.match(out.content, /^Error: the input for "boom" was not valid JSON .*\{"path": "pack\. Call "boom" again/);
});

test("dispatch never throws, whatever a handler throws or returns", async () => {
  const throwingGetter = new Error("x");
  Object.defineProperty(throwingGetter, "message", { get: () => { throw new Error("getter boom"); } });
  const nonStringMessage = new Error("x");
  Object.defineProperty(nonStringMessage, "message", { value: { code: 42 } });
  const badToString = { toString: () => { throw new Error("toString boom"); } };

  const weird: [string, () => Promise<string>][] = [
    ["null-prototype object", async () => { throw Object.create(null); }],
    ["Error with a throwing message getter", async () => { throw throwingGetter; }],
    ["Error with a non-string message", async () => { throw nonStringMessage; }],
    ["thrown string", async () => { throw "plain string"; }],
    ["thrown undefined", async () => { throw undefined; }],
    ["return value with a throwing toString", async () => badToString as unknown as string],
  ];
  for (const [label, handler] of weird) {
    const reg = createRegistry([defineTool({ name: "weird", description: "d", input_schema: { type: "object" }, handler })]);
    const out = await reg.dispatch("weird", {});
    assert.equal(out.isError, true, label);
    assert.match(out.content, /^Error: /, label);
  }
});

test("a malformed schema becomes an error result instead of throwing", async () => {
  const broken = defineTool({
    name: "broken",
    description: "d",
    input_schema: { type: "object", required: "path" as unknown as string[] },
    handler: async () => "unreachable",
  });
  const out = await createRegistry([broken]).dispatch("broken", {});
  assert.equal(out.isError, true);
  assert.match(out.content, /^Error: /);
});
