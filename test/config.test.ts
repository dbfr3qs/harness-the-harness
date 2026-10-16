import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, loadConfig } from "../src/config.ts";

const A = "sk-ant-test-AAAA";
const D = "sk-test-DDDD";

test("the provider defaults to anthropic with its key, URL and model", () => {
  const c = loadConfig({ ANTHROPIC_API_KEY: A });
  assert.equal(c.provider, "anthropic");
  assert.equal(c.apiKey, A);
  assert.equal(c.baseUrl, "https://api.anthropic.com");
  assert.equal(c.model, "claude-sonnet-5-5");
});

test("PROVIDER=deepseek uses DEEPSEEK_API_KEY and DeepSeek's Anthropic-compatible endpoint", () => {
  const c = loadConfig({ PROVIDER: "DeepSeek", ANTHROPIC_API_KEY: A, DEEPSEEK_API_KEY: D });
  assert.equal(c.provider, "deepseek");
  assert.equal(c.apiKey, D, "never the Anthropic key");
  assert.equal(c.baseUrl, "https://api.deepseek.com/anthropic");
  assert.equal(c.model, "deepseek-flash");
  assert.equal(loadConfig({ PROVIDER: "deepseek", DEEPSEEK_API_KEY: D, MODEL: "deepseek-v4-pro" }).model, "deepseek-v4-pro");
});

test("a missing key names the variable for the chosen provider", () => {
  assert.throws(() => loadConfig({}), (e: Error) => e instanceof ConfigError && /^ANTHROPIC_API_KEY is not set/.test(e.message));
  assert.throws(
    () => loadConfig({ PROVIDER: "deepseek", ANTHROPIC_API_KEY: A }),
    (e: Error) => e instanceof ConfigError && /^DEEPSEEK_API_KEY is not set \(PROVIDER=deepseek\)/.test(e.message) && !e.message.includes(A),
  );
});

test("an unknown provider, or a model DeepSeek would silently remap, is a config error", () => {
  assert.throws(() => loadConfig({ PROVIDER: "openai", ANTHROPIC_API_KEY: A }), /PROVIDER must be one of anthropic, deepseek \(got "openai"\)/);
  for (const MODEL of ["claude-opus-5-5", "deepseek-chat", "deepseek-flsh"]) {
    assert.throws(
      () => loadConfig({ PROVIDER: "deepseek", DEEPSEEK_API_KEY: D, MODEL }),
      /MODEL must be one of deepseek-flash, deepseek-v4-pro for PROVIDER=deepseek/,
      MODEL,
    );
  }
});

test("MODEL and BASE_URL override; the ANTHROPIC_ names still work but only for anthropic", () => {
  const legacy = { ANTHROPIC_API_KEY: A, ANTHROPIC_MODEL: "claude-haiku-5-5", ANTHROPIC_BASE_URL: "https://proxy.test/" };
  assert.equal(loadConfig(legacy).model, "claude-haiku-5-5");
  assert.equal(loadConfig(legacy).baseUrl, "https://proxy.test");
  assert.equal(loadConfig({ ...legacy, MODEL: "claude-opus-5-5" }).model, "claude-opus-5-5", "MODEL wins");
  const ds = loadConfig({ ...legacy, PROVIDER: "deepseek", DEEPSEEK_API_KEY: D });
  assert.equal(ds.model, "deepseek-flash", "ANTHROPIC_MODEL is not sent to DeepSeek");
  assert.equal(ds.baseUrl, "https://api.deepseek.com/anthropic");
  assert.equal(loadConfig({ ...legacy, PROVIDER: "deepseek", DEEPSEEK_API_KEY: D, BASE_URL: "https://ds.test/x/" }).baseUrl, "https://ds.test/x");
});

test("SHOW_THINKING defaults to off", () => {
  assert.equal(loadConfig({ ANTHROPIC_API_KEY: A }).showThinking, false);
  assert.equal(loadConfig({ ANTHROPIC_API_KEY: A, SHOW_THINKING: "1" }).showThinking, true);
});

test("every key in the environment is listed for transcript scrubbing", () => {
  assert.deepEqual(loadConfig({ ANTHROPIC_API_KEY: A, DEEPSEEK_API_KEY: D }).secrets, [A, D]);
  assert.deepEqual(loadConfig({ PROVIDER: "deepseek", DEEPSEEK_API_KEY: D }).secrets, [D]);
});
