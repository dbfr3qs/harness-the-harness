import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchModelLimits } from "../src/client.ts";
import { loadConfig } from "../src/config.ts";
import { contextAfter, contextBar, contextSummary, describeContext, formatTokens } from "../src/context_meter.ts";
import type { MessageResponse } from "../src/types.ts";

const res = (usage: MessageResponse["usage"]): MessageResponse => ({ id: "m", model: "x", role: "assistant", content: [], stop_reason: "end_turn", usage });

test("context in use counts fresh, cached and newly cached input plus the output", () => {
  assert.equal(contextAfter(res({ input_tokens: 300, output_tokens: 50, cache_read_input_tokens: 4000, cache_creation_input_tokens: 10 })), 4360);
  assert.equal(contextAfter(res({ input_tokens: 300, output_tokens: 50, cache_read_input_tokens: null })), 350);
});

test("token counts are shortened readably", () => {
  assert.deepEqual([0, 999, 1000, 1234, 23_456, 200_000, 1_000_000, 1_500_000].map(formatTokens), ["0", "999", "1k", "1.2k", "23.5k", "200k", "1M", "1.5M"]);
});

test("the summary after each answer shows used/window and a percentage", () => {
  assert.equal(contextSummary({ used: 23_456, window: 1_000_000 }), "context 23.5k/1M (2%)");
  assert.equal(contextSummary({ used: 900, window: 1_000_000 }), "context 900/1M (<1%)");
  assert.equal(contextSummary({ used: 170_000, window: 200_000 }), "context 170k/200k (85%)");
  assert.equal(contextSummary({ used: 4000, window: undefined }), "context 4k");
  assert.equal(contextSummary({ used: 4000, window: 1_000_000, stale: "switched" }), "context ≈4k/1M (<1%)");
});

test("the bar fills in proportion and stays within its width", () => {
  assert.equal(contextBar(0, 10), "░░░░░░░░░░");
  assert.equal(contextBar(0.5, 10), "█████░░░░░");
  assert.equal(contextBar(1.3, 10), "██████████");
});

test("/context reports used, window, what's left, and warns when nearly full", () => {
  assert.equal(describeContext({ used: 0, window: 1_000_000 }, "deepseek-flash", 0), "Context: empty (no conversation yet). Window for deepseek-flash: 1,000,000 tokens.");
  const normal = describeContext({ used: 250_000, window: 1_000_000 }, "claude-haiku-5-5", 12);
  assert.match(normal, /^Context: 250,000 of 1,000,000 tokens \(25%\) · claude-haiku-5-5 · 12 message\(s\)\n  ████████░{22}  750k left\n  Measured after the last response/);
  assert.doesNotMatch(normal, /full/);
  assert.match(describeContext({ used: 900_000, window: 1_000_000 }, "m", 40), /\n\[context 90% full: .*\/reset starts a fresh conversation\]/);
  assert.match(describeContext({ used: 5000, window: undefined }, "custom", 2), /isn't known; set CONTEXT_WINDOW/);
  assert.match(describeContext({ used: 5000, window: 1_000_000, stale: "measured with x" }, "m", 2), /\n  Approximate: measured with x\.$/);
});

test("limits come from Anthropic's models API; failures and other providers give none", async () => {
  const calls: string[] = [];
  const reply = (status: number, body: unknown) =>
    (async (url: string, init: RequestInit) => {
      calls.push(`${url} ${(init.headers as Record<string, string>)["x-api-key"]}`);
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
  const cfg = { provider: "anthropic" as const, apiKey: "K", baseUrl: "https://api.test", model: "claude-haiku-5-5" };
  assert.deepEqual(await fetchModelLimits(cfg, { fetch: reply(200, { max_input_tokens: 1_000_000, max_tokens: 128_000 }) }), {
    contextWindow: 1_000_000,
    maxOutput: 128_000,
  });
  assert.equal(calls[0], "https://api.test/v1/models/claude-haiku-5-5 K");
  assert.deepEqual(await fetchModelLimits(cfg, { fetch: reply(404, { error: {} }) }), {});
  assert.deepEqual(await fetchModelLimits(cfg, { fetch: reply(200, { max_input_tokens: "lots", max_tokens: 64_000 }) }), { maxOutput: 64_000 });
  const broken = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  assert.deepEqual(await fetchModelLimits(cfg, { fetch: broken }), {});
  assert.deepEqual(await fetchModelLimits({ ...cfg, provider: "deepseek" }, { fetch: reply(200, { max_input_tokens: 5 }) }), {});
});

test("CONTEXT_WINDOW overrides the window when set", () => {
  assert.equal(loadConfig({ ANTHROPIC_API_KEY: "k" }).contextWindow, undefined);
  assert.equal(loadConfig({ ANTHROPIC_API_KEY: "k", CONTEXT_WINDOW: "200000" }).contextWindow, 200_000);
  assert.throws(() => loadConfig({ ANTHROPIC_API_KEY: "k", CONTEXT_WINDOW: "big" }), /CONTEXT_WINDOW must be an integer >= 1/);
});
