import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent } from "../src/agent.ts";
import { createRegistry, defineTool } from "../src/registry.ts";
import type { ToolOutcome } from "../src/registry.ts";
import type {
  AssistantBlock,
  Message,
  MessageResponse,
  ModelFn,
  ModelRequest,
  StopReason,
  ToolResultBlock,
  ToolUseBlock,
} from "../src/types.ts";

// --- fixtures ---------------------------------------------------------------

const registry = createRegistry([
  defineTool({
    name: "echo",
    description: "Echo text back.",
    input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    handler: async (input) => `echo: ${input.text}`,
  }),
  defineTool({
    name: "big",
    description: "Return a large string.",
    input_schema: { type: "object", properties: {} },
    handler: async () => "x".repeat(250),
  }),
]);

let idCounter = 0;
const toolUse = (name: string, input: unknown): ToolUseBlock => ({
  type: "tool_use",
  id: `toolu_${++idCounter}`,
  name,
  input,
});
const text = (t: string) => ({ type: "text" as const, text: t });

function reply(
  content: AssistantBlock[],
  stop_reason: StopReason = content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
  usage: MessageResponse["usage"] = { input_tokens: 10, output_tokens: 5 },
): MessageResponse {
  return { id: `msg_${++idCounter}`, model: "fake", role: "assistant", content, stop_reason, usage };
}

// A scripted fake model. Records a deep copy of every request, since `messages` is mutated in place.
function fakeModel(script: MessageResponse[] | (() => MessageResponse)) {
  const requests: ModelRequest[] = [];
  const model: ModelFn = async (req) => {
    requests.push(structuredClone(req));
    if (typeof script === "function") return script();
    const next = script.shift();
    if (!next) throw new Error("fake model: script exhausted");
    return next;
  };
  return { model, requests };
}

function run(model: ModelFn, messages: Message[], extra: Partial<Parameters<typeof runAgent>[0]> = {}) {
  return runAgent({ model, registry, system: "sys", messages, maxTurns: 5, maxToolOutputChars: 100, ...extra });
}

const user = (content: string): Message => ({ role: "user", content });
const resultsOf = (m: Message | undefined): ToolResultBlock[] => {
  assert.ok(m && m.role === "user" && Array.isArray(m.content), "expected a user message with blocks");
  return m.content as ToolResultBlock[];
};

// --- the eight acceptance cases --------------------------------------------

test("1. plain reply, no tools: done in 1 turn", async () => {
  const { model, requests } = fakeModel([reply([text("Hello!")])]);
  const messages = [user("hi")];
  const out = await run(model, messages);
  assert.equal(out.stopReason, "done");
  assert.equal(out.turns, 1);
  assert.equal(out.finalText, "Hello!");
  assert.equal(messages.length, 2);
  assert.equal(requests[0]!.system, "sys");
  assert.deepEqual(requests[0]!.tools.map((t) => t.name), ["echo", "big"]);
});

test("2. one tool call then a reply: done in 2 turns with correct history", async () => {
  const call = toolUse("echo", { text: "ping" });
  const { model } = fakeModel([reply([text("Calling."), call]), reply([text("Got pong.")])]);
  const messages = [user("go")];
  const out = await run(model, messages);
  assert.equal(out.stopReason, "done");
  assert.equal(out.turns, 2);
  assert.equal(out.finalText, "Got pong.");
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  assert.deepEqual(resultsOf(messages[2]), [
    { type: "tool_result", tool_use_id: call.id, content: "echo: ping" },
  ]);
});

test("3. two tool_use blocks: one user message with both results, in order", async () => {
  const a = toolUse("echo", { text: "one" });
  const b = toolUse("echo", { text: "two" });
  const { model } = fakeModel([reply([a, b]), reply([text("done")])]);
  const messages = [user("go")];
  await run(model, messages);
  assert.equal(messages.length, 4);
  const results = resultsOf(messages[2]);
  assert.deepEqual(results.map((r) => r.tool_use_id), [a.id, b.id]);
  assert.deepEqual(results.map((r) => r.content), ["echo: one", "echo: two"]);
});

test("4. missing required key: is_error result and the loop continues", async () => {
  const call = toolUse("echo", {});
  const { model, requests } = fakeModel([reply([call]), reply([text("Sorry, retrying is pointless.")])]);
  const messages = [user("go")];
  const out = await run(model, messages);
  assert.equal(out.stopReason, "done");
  assert.equal(out.turns, 2);
  const [result] = resultsOf(messages[2]);
  assert.equal(result!.is_error, true);
  assert.match(result!.content, /^Error: missing required key\(s\) for "echo": text/);
  assert.equal(requests.length, 2);
});

test("5. a model that always calls tools: max_turns", async () => {
  const { model, requests } = fakeModel(() => reply([toolUse("echo", { text: "again" })]));
  const messages = [user("go")];
  const out = await run(model, messages, { maxTurns: 3 });
  assert.equal(out.stopReason, "max_turns");
  assert.equal(out.turns, 3);
  assert.equal(requests.length, 3);
  // History is still valid: every tool_use has its tool_result.
  assert.equal(messages.at(-1)!.role, "user");
  assert.equal(messages.length, 1 + 3 * 2);
});

test("6. oversized tool result is truncated with the marker", async () => {
  const { model } = fakeModel([reply([toolUse("big", {})]), reply([text("ok")])]);
  const messages = [user("go")];
  const seen: ToolOutcome[] = [];
  await run(model, messages, { hooks: { onToolResult: (_c, o) => seen.push(o) } });
  const [result] = resultsOf(messages[2]);
  assert.equal(result!.content, `${"x".repeat(100)}\n[truncated: 150 more chars]`);
  assert.equal(seen[0]!.content, result!.content);
});

test("7. unknown block types are sent back unchanged in the next request", async () => {
  const thinking = { type: "thinking", thinking: "Let me think.", signature: "sig==" };
  const futureBlock = { type: "shiny_new_block", payload: { nested: [1, 2, 3] } };
  const call = { ...toolUse("echo", { text: "hi" }), caller: { type: "direct" } };
  const first = reply([thinking, text("Calling."), futureBlock, call]);
  const expected = structuredClone(first.content);
  const { model, requests } = fakeModel([first, reply([text("done")])]);
  await run(model, [user("go")]);
  assert.deepEqual(requests[1]!.messages[1], { role: "assistant", content: expected });
});

test("8. usage is summed across turns", async () => {
  const { model } = fakeModel([
    reply([toolUse("echo", { text: "a" })], "tool_use", { input_tokens: 100, output_tokens: 20 }),
    reply([toolUse("echo", { text: "b" }), toolUse("echo", { text: "c" })], "tool_use", {
      input_tokens: 150,
      output_tokens: 30,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: null,
    }),
    reply([text("done")], "end_turn", { input_tokens: 200, output_tokens: 40, cache_read_input_tokens: 1200, cache_creation_input_tokens: 7 }),
  ]);
  const out = await run(model, [user("go")]);
  assert.deepEqual(out.usage, { input_tokens: 450, output_tokens: 90, cache_read_input_tokens: 2200, cache_creation_input_tokens: 7 });
  assert.equal(out.turns, 3);
  assert.equal(out.toolCalls, 3);
});

// --- additional stop-condition and hook coverage ---------------------------

test("max_tokens with no tool calls stops with max_tokens", async () => {
  const { model } = fakeModel([reply([text("A very long ans")], "max_tokens")]);
  const out = await run(model, [user("go")]);
  assert.equal(out.stopReason, "max_tokens");
  assert.equal(out.finalText, "A very long ans");
});

test("refusal stops with refusal", async () => {
  const { model } = fakeModel([reply([], "refusal")]);
  const out = await run(model, [user("go")]);
  assert.equal(out.stopReason, "refusal");
  assert.equal(out.finalText, "");
});

test("tool_use cut off by max_tokens is not run; each gets an error and the loop continues", async () => {
  let ran = 0;
  const counting = createRegistry([
    defineTool({
      name: "echo",
      description: "Echo.",
      input_schema: { type: "object", properties: {} },
      handler: async () => `ran ${++ran}`,
    }),
  ]);
  const a = toolUse("echo", {});
  const b = toolUse("echo", {});
  const { model } = fakeModel([reply([a, b], "max_tokens"), reply([text("ok")])]);
  const messages = [user("go")];
  const out = await runAgent({ model, registry: counting, system: "s", messages, maxTurns: 5, maxToolOutputChars: 100 });
  assert.equal(ran, 0);
  assert.equal(out.stopReason, "done");
  const results = resultsOf(messages[2]);
  assert.deepEqual(results.map((r) => r.tool_use_id), [a.id, b.id]);
  for (const r of results) {
    assert.equal(r.is_error, true);
    assert.match(r.content, /max_tokens/);
  }
});

test("hooks fire for each response, tool call and tool result", async () => {
  const a = toolUse("echo", { text: "1" });
  const b = toolUse("nope", {});
  const { model } = fakeModel([reply([a, b]), reply([text("done")])]);
  const events: string[] = [];
  await run(model, [user("go")], {
    hooks: {
      onResponse: (r) => events.push(`response:${r.stop_reason}`),
      onToolCall: (c) => events.push(`call:${c.name}`),
      onToolResult: (c, o) => events.push(`result:${c.name}:${o.isError}`),
    },
  });
  assert.deepEqual(events, [
    "response:tool_use",
    "call:echo",
    "result:echo:false",
    "call:nope",
    "result:nope:true",
    "response:end_turn",
  ]);
});

test("model errors propagate to the caller", async () => {
  const model: ModelFn = async () => {
    throw new Error("API down");
  };
  await assert.rejects(run(model, [user("go")]), /API down/);
});
