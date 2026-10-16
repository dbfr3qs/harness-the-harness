import { test } from "node:test";
import assert from "node:assert/strict";
import { createAnthropicClient } from "../src/client.ts";
import type { ClientConfig } from "../src/client.ts";
import type { ModelRequest } from "../src/types.ts";

const KEY = "sk-ant-test-SECRET-0123456789";
const config: ClientConfig = {
  provider: "anthropic",
  apiKey: KEY,
  baseUrl: "https://api.example.test",
  model: "claude-test",
  maxTokens: 100,
  timeoutMs: 1000,
  maxRetries: 2,
  stream: false,
};
const req: ModelRequest = { system: "sys", messages: [{ role: "user", content: "hi" }], tools: [] };
const okBody = {
  id: "msg_1",
  model: "claude-test",
  role: "assistant",
  content: [{ type: "text", text: "hello" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
};

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

// A scripted fetch: each entry is a Response or an Error to throw.
function scriptedFetch(script: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = script.shift();
    if (!next) throw new Error("scripted fetch exhausted");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function client(script: (Response | Error)[], sleeps: number[] = [], cfg = config) {
  const { fetchImpl, calls } = scriptedFetch(script);
  const model = createAnthropicClient(cfg, {}, {
    fetch: fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { model, calls, sleeps };
}

test("sends the documented headers and body; omits tools when empty", async () => {
  const { model, calls } = client([json(200, okBody)]);
  const res = await model(req);
  assert.equal(res.content[0]!.type, "text");
  assert.equal(calls[0]!.url, "https://api.example.test/v1/messages");
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], KEY);
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
    model: "claude-test",
    max_tokens: 100,
    system: "sys",
    messages: [{ role: "user", content: "hi" }],
  });
});

test("401 error is clear and never contains the key", async () => {
  const { model } = client([
    json(401, { type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${KEY}` } }),
  ]);
  await assert.rejects(model(req), (err: Error) => {
    assert.match(err.message, /401 authentication_error/);
    assert.match(err.message, /check ANTHROPIC_API_KEY/);
    assert.ok(!err.message.includes(KEY), "key leaked into error");
    return true;
  });
});

test("DeepSeek: same request shape under its base URL; errors name DeepSeek and its key variable", async () => {
  const ds: ClientConfig = { ...config, provider: "deepseek", baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-flash" };
  const ok = client([json(200, okBody)], [], ds);
  await ok.model(req);
  assert.equal(ok.calls[0]!.url, "https://api.deepseek.com/anthropic/v1/messages");
  assert.equal((ok.calls[0]!.init.headers as Record<string, string>)["x-api-key"], KEY);

  const message = `Authentication Fails, Your api key: ****${KEY.slice(-4)} is invalid, full: ${KEY}`;
  const bad = client([json(401, { error: { type: "authentication_error", message } })], [], ds);
  await assert.rejects(bad.model(req), (err: Error) => {
    assert.match(err.message, /^DeepSeek API error: HTTP 401 authentication_error/);
    assert.match(err.message, /check DEEPSEEK_API_KEY/);
    assert.match(err.message, /Your api key: \[redacted\] is invalid/);
    assert.ok(!err.message.includes(KEY), "key leaked into error");
    assert.ok(!err.message.includes(KEY.slice(-4)), "masked key fragment leaked into error");
    return true;
  });
});

test("with showThinking, Claude 5 models are asked for summarized thinking; nothing else changes", async () => {
  const body = async (cfg: Partial<ClientConfig>) => {
    const c = client([json(200, okBody)], [], { ...config, ...cfg });
    await c.model(req);
    return JSON.parse(String(c.calls[0]!.init.body)) as Record<string, unknown>;
  };
  const summarized = { type: "adaptive", display: "summarized" };
  for (const model of ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5", "claude-fable-5-1"]) {
    assert.deepEqual((await body({ model, showThinking: true })).thinking, summarized, model);
    assert.equal((await body({ model, showThinking: false })).thinking, undefined, model);
  }
  // Older Claude models only think when thinking is turned on, which would change cost: left alone.
  for (const model of ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001", "claude-test"]) {
    assert.equal((await body({ model, showThinking: true })).thinking, undefined, model);
  }
  // DeepSeek already returns its thinking.
  assert.equal((await body({ provider: "deepseek", model: "deepseek-flash", showThinking: true })).thinking, undefined);
});

test("400 throws immediately with error.type and error.message, no retry", async () => {
  const { model, calls } = client([
    json(400, { type: "error", error: { type: "invalid_request_error", message: "messages: bad shape" } }),
  ]);
  await assert.rejects(model(req), /HTTP 400 invalid_request_error: messages: bad shape/);
  assert.equal(calls.length, 1);
});

test("retries 429, 500 and 529, honouring retry-after", async () => {
  const sleeps: number[] = [];
  const { fetchImpl, calls } = scriptedFetch([
    json(429, { error: { type: "rate_limit_error", message: "slow down" } }, { "retry-after": "3" }),
    json(529, { error: { type: "overloaded_error", message: "busy" } }),
    json(200, okBody),
  ]);
  const model = createAnthropicClient(config, {}, { fetch: fetchImpl, sleep: async (ms) => void sleeps.push(ms) });
  const res = await model(req);
  assert.equal(res.id, "msg_1");
  assert.equal(calls.length, 3);
  assert.equal(sleeps[0], 3000);
  assert.ok(sleeps[1]! >= 500 && sleeps[1]! <= 1500, `backoff ${sleeps[1]} out of range`);

  const again = client([json(500, { error: { type: "api_error", message: "oops" } }), json(200, okBody)]);
  assert.equal((await again.model(req)).id, "msg_1");
});

test("network errors retry, then fail after maxRetries + 1 attempts", async () => {
  const { model, calls, sleeps } = client([
    new TypeError("fetch failed"),
    new TypeError("fetch failed"),
    new TypeError("fetch failed"),
  ]);
  await assert.rejects(model(req), /failed after 3 attempt\(s\): network error: fetch failed/);
  assert.equal(calls.length, 3);
  assert.equal(sleeps.length, 2);
});

test("timeouts are retried and reported", async () => {
  const timeout = new DOMException("The operation timed out.", "TimeoutError");
  const { model } = client([timeout, timeout, timeout]);
  await assert.rejects(model(req), /timed out \(no data for 1000 ms\)/);
});

test("a response without a content array is a descriptive error", async () => {
  const { model } = client([json(200, { id: "x", oops: true })]);
  await assert.rejects(model(req), /no content array/);
});
