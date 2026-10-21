import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createAnthropicClient } from "../src/client.ts";
import type { ClientConfig } from "../src/client.ts";
import { createSpinner, SPINNER_FRAMES } from "../src/spinner.ts";
import { parseSse } from "../src/sse.ts";
import type { ModelRequest } from "../src/types.ts";

const config: ClientConfig = {
  provider: "anthropic",
  apiKey: "sk-ant-test-SECRET",
  baseUrl: "https://api.example.test",
  model: "claude-test",
  maxTokens: 100,
  timeoutMs: 1000,
  maxRetries: 2,
  stream: true,
};
const req: ModelRequest = { system: "sys", messages: [{ role: "user", content: "hi" }], tools: [] };

// --- helpers ----------------------------------------------------------------

// Splits text into small chunks so events, lines and even UTF-8 characters straddle chunk boundaries.
function bodyFrom(text: string, chunkSize = 7, stall = false): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset < bytes.length) {
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
        offset += chunkSize;
      } else if (!stall) {
        controller.close();
      }
      // when stalling, never close: simulates a connection that goes quiet
    },
  });
}

const sseResponse = (text: string, stall = false) =>
  new Response(bodyFrom(text, 7, stall), { status: 200, headers: { "content-type": "text/event-stream" } });

function sse(...events: object[]): string {
  return events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

const start = (extra: object = {}) => ({
  type: "message_start",
  message: {
    id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 }, ...extra,
  },
});
const textBlock = (index: number, ...pieces: string[]) => [
  { type: "content_block_start", index, content_block: { type: "text", text: "" } },
  ...pieces.map((text) => ({ type: "content_block_delta", index, delta: { type: "text_delta", text } })),
  { type: "content_block_stop", index },
];
const end = (stop_reason = "end_turn", output_tokens = 20) => [
  { type: "message_delta", delta: { stop_reason, stop_sequence: null }, usage: { output_tokens } },
  { type: "message_stop" },
];

function client(script: Response[], hooks: Parameters<typeof createAnthropicClient>[1] = {}, cfg = config, now?: () => number) {
  const bodies: unknown[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const next = script.shift();
    if (!next) throw new Error("scripted fetch exhausted");
    if (!next.body) return next;
    // Like real fetch, aborting the request signal errors the response body.
    const body = next.body.pipeThrough(new TransformStream(), { signal: init.signal ?? undefined });
    return new Response(body, { status: next.status, headers: next.headers });
  }) as unknown as typeof fetch;
  const model = createAnthropicClient(cfg, hooks, { fetch: fetchImpl, sleep: async () => {}, now });
  return { model, bodies };
}

// --- SSE parsing ------------------------------------------------------------

test("parseSse handles CRLF, comments, multi-line data and a missing final blank line", async () => {
  const raw = ": keep-alive\r\nevent: a\r\ndata: one\r\ndata: two\r\n\r\ndata: {\"x\":1}\n\nevent: b\ndata: last";
  const events = [];
  for await (const e of parseSse(bodyFrom(raw, 3))) events.push(e);
  assert.deepEqual(events, [
    { event: "a", data: "one\ntwo" },
    { event: "message", data: '{"x":1}' },
    { event: "b", data: "last" },
  ]);
});

// --- rebuilding messages ----------------------------------------------------

test("a real captured tool-use stream rebuilds the same message the API returns", async () => {
  const raw = await readFile(new URL("./fixtures/tool-use.sse", import.meta.url), "utf8");
  const deltas: string[] = [];
  const { model, bodies } = client([sseResponse(raw)], { onTextDelta: (t) => deltas.push(t) });
  const res = await model(req);

  assert.equal((bodies[0] as { stream?: boolean }).stream, true);
  assert.equal(res.stop_reason, "tool_use");
  assert.equal(res.usage.input_tokens, 387);
  assert.equal(res.usage.output_tokens, 58);
  assert.deepEqual(res.content, [
    { type: "text", text: "Reading package.json now." },
    {
      type: "tool_use",
      id: "toolu_01VJCxFtprREqKh9Z1qRB3PN",
      name: "read_file",
      input: { path: "package.json" },
      caller: { type: "direct" },
    },
  ]);
  assert.deepEqual(deltas, ["Re", "ading package", ".json now."]);
});

test("a real captured DeepSeek stream (thinking, then a tool call with empty input) rebuilds correctly", async () => {
  const raw = await readFile(new URL("./fixtures/deepseek-tool-use.sse", import.meta.url), "utf8");
  const deltas: string[] = [];
  const ds: ClientConfig = { ...config, provider: "deepseek", model: "deepseek-flash" };
  const { model } = client([sseResponse(raw)], { onTextDelta: (t) => deltas.push(t) }, ds);
  const res = await model(req);
  assert.equal(res.stop_reason, "tool_use");
  assert.equal(res.usage.output_tokens, 33);
  assert.deepEqual(res.content, [
    {
      type: "thinking",
      thinking: "The user wants the current time. Call get_time.",
      signature: "6ae94ce6-a400-4743-b944-5e26f3be0b41",
    },
    { type: "tool_use", id: "call_00_BVsbFXIgOkaT4Fso2vwq4266", name: "get_time", input: {} },
  ]);
  assert.deepEqual(deltas, [], "thinking is not printed as text");
});

test("readable thinking streams to onThinkingDelta only when showThinking is on", async () => {
  const raw = await readFile(new URL("./fixtures/deepseek-tool-use.sse", import.meta.url), "utf8");
  const ds: ClientConfig = { ...config, provider: "deepseek", model: "deepseek-flash" };
  for (const showThinking of [true, false]) {
    const thinking: string[] = [];
    const { model } = client([sseResponse(raw)], { onThinkingDelta: (t) => thinking.push(t) }, { ...ds, showThinking });
    const res = await model(req);
    assert.equal(thinking.join(""), showThinking ? "The user wants the current time. Call get_time." : "");
    assert.equal(res.content[0]!.type, "thinking", "kept in the message either way");
  }
});

test("thinking, signature and citations are rebuilt; thinking is not shown as text", async () => {
  const deltas: string[] = [];
  const stream = sse(
    start(),
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me " } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "think." } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "c2lnbmF0dXJl" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "", citations: [] } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Quoted ✓" } },
    { type: "content_block_delta", index: 1, delta: { type: "citations_delta", citation: { cited_text: "x" } } },
    { type: "content_block_stop", index: 1 },
    ...end(),
  );
  const { model } = client([sseResponse(stream)], { onTextDelta: (t) => deltas.push(t) });
  const res = await model(req);
  assert.deepEqual(res.content, [
    { type: "thinking", thinking: "Let me think.", signature: "c2lnbmF0dXJl" },
    { type: "text", text: "Quoted ✓", citations: [{ cited_text: "x" }] },
  ]);
  assert.deepEqual(deltas, ["Quoted ✓"]);
  assert.equal(res.stop_reason, "end_turn");
});

test("a tool call with no input deltas gets {}", async () => {
  const stream = sse(
    start(),
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "get_time", input: {} } },
    { type: "content_block_stop", index: 0 },
    ...end("tool_use"),
  );
  const { model } = client([sseResponse(stream)]);
  const res = await model(req);
  assert.deepEqual(res.content, [{ type: "tool_use", id: "t1", name: "get_time", input: {} }]);
});

test("tool input cut off by max_tokens becomes { _invalidJson }", async () => {
  const stream = sse(
    start(),
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "read_file", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path": "pack' } },
    ...end("max_tokens"),
  );
  const { model } = client([sseResponse(stream)]);
  const res = await model(req);
  assert.deepEqual(res.content[0], { type: "tool_use", id: "t1", name: "read_file", input: { _invalidJson: '{"path": "pack' } });
  assert.equal(res.stop_reason, "max_tokens");
});

test("ping and unknown event types are ignored", async () => {
  const stream = sse(start(), { type: "ping" }, { type: "brand_new_event" }, ...textBlock(0, "ok"), ...end());
  const { model } = client([sseResponse(stream)]);
  assert.deepEqual((await model(req)).content, [{ type: "text", text: "ok" }]);
});

// --- failures and retries ---------------------------------------------------

test("an overloaded error event before any text is retried", async () => {
  const failing = sse(start(), { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
  const good = sse(start(), ...textBlock(0, "hello"), ...end());
  const retries: string[] = [];
  const { model, bodies } = client([sseResponse(failing), sseResponse(good)], { onRetry: (r) => retries.push(r.reason) });
  const res = await model(req);
  assert.equal(res.content.length, 1);
  assert.equal(bodies.length, 2);
  assert.match(retries[0]!, /overloaded_error: Overloaded/);
});

test("an error event after text has been shown fails without retrying", async () => {
  const stream = sse(start(), { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Half an ans" } },
    { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
  const deltas: string[] = [];
  const { model, bodies } = client([sseResponse(stream), sseResponse("")], { onTextDelta: (t) => deltas.push(t) });
  await assert.rejects(model(req), /stream failed after output began: stream error overloaded_error/);
  assert.equal(bodies.length, 1);
  assert.deepEqual(deltas, ["Half an ans"]);
});

test("a non-retryable error event fails immediately", async () => {
  const stream = sse(start(), { type: "error", error: { type: "invalid_request_error", message: "bad" } });
  const { model, bodies } = client([sseResponse(stream)]);
  await assert.rejects(model(req), /error in stream: invalid_request_error: bad/);
  assert.equal(bodies.length, 1);
});

test("an unknown delta type is fatal, because the block cannot be rebuilt verbatim", async () => {
  const stream = sse(start(), { type: "content_block_start", index: 0, content_block: { type: "mystery" } },
    { type: "content_block_delta", index: 0, delta: { type: "mystery_delta", stuff: 1 } }, ...end());
  const { model, bodies } = client([sseResponse(stream)]);
  await assert.rejects(model(req), /unknown delta type "mystery_delta".*STREAM=0/);
  assert.equal(bodies.length, 1);
});

test("a stream that ends before message_stop is retried, then reported", async () => {
  const truncated = sse(start(), { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  const { model, bodies } = client([sseResponse(truncated), sseResponse(truncated), sseResponse(truncated)]);
  await assert.rejects(model(req), /failed after 3 attempt\(s\): stream ended before message_stop/);
  assert.equal(bodies.length, 3);
});

test("the idle timeout fires when the stream goes quiet", async () => {
  const quiet = sse(start());
  const { model } = client([sseResponse(quiet, true)], {}, { ...config, timeoutMs: 50, maxRetries: 0 });
  await assert.rejects(model(req), /timed out \(no data for 50 ms\)/);
});

test("a slow stream that keeps sending data is not cut off by the idle timeout", async () => {
  const text = sse(start(), ...textBlock(0, "a", "b", "c", "d"), ...end());
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const slow = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise((r) => setTimeout(r, 15)); // 15 ms per chunk; whole stream takes far longer than 50 ms
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + 40));
      offset += 40;
    },
  });
  const { model } = client([new Response(slow, { status: 200 })], {}, { ...config, timeoutMs: 50, maxRetries: 0 });
  assert.deepEqual((await model(req)).content, [{ type: "text", text: "abcd" }]);
});

// --- spinner ----------------------------------------------------------------

test("spinner frames go from one to five dots and back", () => {
  assert.deepEqual(SPINNER_FRAMES, [".", "..", "...", "....", ".....", "....", "...", ".."]);
});

test("spinner draws on a TTY, erases on stop, and does nothing otherwise", () => {
  const writes: string[] = [];
  const tty = createSpinner({ write: (s: string) => writes.push(s), isTTY: true }, 10_000);
  tty.start();
  tty.start(); // idempotent
  tty.stop();
  tty.stop(); // idempotent
  assert.deepEqual(writes, ["\r.\x1b[K", "\r\x1b[K"]);

  const piped: string[] = [];
  const quiet = createSpinner({ write: (s: string) => piped.push(s), isTTY: false }, 10_000);
  quiet.start();
  quiet.stop();
  assert.deepEqual(piped, []);
});

// --- token-speed timing (prefill / decode) ----------------------------------

const clock = (...vals: number[]) => {
  let i = 0;
  return () => (i < vals.length ? vals[i++]! : vals[vals.length - 1]!);
};

test("streaming reports prefill and decode timing via onFirstToken/onStreamDone", async () => {
  let first: { inputTokens: number; ttftMs: number } | undefined;
  let done: { outputTokens: number; decodeMs: number } | undefined;
  const script = sse(start({ usage: { input_tokens: 100, output_tokens: 1 } }), ...textBlock(0, "hi"), ...end("end_turn", 40));
  const { model } = client(
    [sseResponse(script)],
    { onFirstToken: (i) => { first = i; }, onStreamDone: (d) => { done = d; } },
    config,
    clock(0, 200, 700),
  );
  await model(req);
  assert.deepEqual(first, { inputTokens: 100, ttftMs: 200 });
  assert.deepEqual(done, { outputTokens: 40, decodeMs: 500 });
});

test("non-streaming fires neither timing hook", async () => {
  let fired = false;
  const body = JSON.stringify({
    id: "msg_1", type: "message", role: "assistant", model: "claude-test",
    content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 40 },
  });
  const resp = new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  const { model } = client([resp], { onFirstToken: () => { fired = true; }, onStreamDone: () => { fired = true; } }, { ...config, stream: false });
  await model(req);
  assert.equal(fired, false);
});

test("a tool-only stream fires neither timing hook", async () => {
  let fired = false;
  const script = sse(
    start(),
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "x", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
    { type: "content_block_stop", index: 0 },
    ...end("tool_use", 5),
  );
  const { model } = client([sseResponse(script)], { onFirstToken: () => { fired = true; }, onStreamDone: () => { fired = true; } });
  await model(req);
  assert.equal(fired, false);
});

test("a retry before any token fires onFirstToken exactly once", async () => {
  let firstCount = 0;
  let doneCount = 0;
  const errored = sse(start(), { type: "error", error: { type: "overloaded_error", message: "busy" } });
  const clean = sse(start({ usage: { input_tokens: 100, output_tokens: 1 } }), ...textBlock(0, "hi"), ...end("end_turn", 40));
  const { model } = client(
    [sseResponse(errored), sseResponse(clean)],
    { onFirstToken: () => { firstCount++; }, onStreamDone: () => { doneCount++; } },
  );
  await model(req);
  assert.equal(firstCount, 1);
  assert.equal(doneCount, 1);
});
