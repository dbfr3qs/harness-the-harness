import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { runDefaultsCommand } from "../src/defaults_command.ts";
import type { DefaultsCommandContext } from "../src/defaults_command.ts";
import { runProviderCommand } from "../src/model_command.ts";
import { formatSettings, loadSettings, parseSettings } from "../src/settings.ts";
import type { Provider } from "../src/config.ts";

let dir: string;
let n = 0;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-settings-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const keys = { ANTHROPIC_API_KEY: "sk-ant-A", DEEPSEEK_API_KEY: "sk-D" };

// --- the file ------------------------------------------------------------------

test("settings round-trip through the file, with unlimited turns written as \"unlimited\"", async () => {
  const s = { provider: "deepseek" as const, models: { deepseek: "deepseek-v4-pro", anthropic: "claude-haiku-5-5" }, showThinking: true, maxTurns: Infinity };
  const text = formatSettings(s);
  assert.equal(
    text,
    '{\n  "provider": "deepseek",\n  "models": {\n    "anthropic": "claude-haiku-5-5",\n    "deepseek": "deepseek-v4-pro"\n  },\n  "showThinking": true,\n  "maxTurns": "unlimited"\n}\n',
  );
  const path = join(dir, `s${++n}.json`);
  await writeFile(path, text);
  assert.deepEqual(await loadSettings(path), s);
});

test("a missing file means no saved settings; broken or invalid ones are errors naming the file", async () => {
  assert.deepEqual(await loadSettings(join(dir, "nope.json")), {});
  const bad = join(dir, "bad.json");
  await writeFile(bad, "{ nope");
  await assert.rejects(loadSettings(bad), /bad\.json is not valid JSON/);
  const cases: [unknown, RegExp][] = [
    [[], /must be a JSON object/],
    [{ apiKey: "x" }, /unknown setting\(s\) "apiKey"; allowed: provider, models, showThinking, maxTurns/],
    [{ provider: "openai" }, /"provider" must be one of anthropic, deepseek/],
    [{ models: { openai: "gpt" } }, /"models" has unknown provider "openai"/],
    [{ models: { deepseek: "claude-opus-5-5" } }, /"models\.deepseek" must be one of deepseek-flash, deepseek-v4-pro/],
    [{ models: { anthropic: "" } }, /"models\.anthropic" must be a model ID/],
    [{ showThinking: "yes" }, /"showThinking" must be true or false/],
    [{ maxTurns: 0 }, /"maxTurns" must be a whole number of 1 or more, or "unlimited"/],
    [{ maxTurns: "lots" }, /"maxTurns" must be a whole number/],
  ];
  for (const [json, pattern] of cases) {
    assert.throws(() => parseSettings(json, "h.json"), (e: Error) => /^h\.json: /.test(e.message) && pattern.test(e.message), JSON.stringify(json));
  }
});

// --- precedence -----------------------------------------------------------------

test("saved settings set the starting provider, model, thinking and turns", () => {
  const c = loadConfig(keys, { provider: "deepseek", models: { deepseek: "deepseek-v4-pro" }, showThinking: true, maxTurns: Infinity });
  assert.deepEqual([c.provider, c.model, c.showThinking, c.maxTurns], ["deepseek", "deepseek-v4-pro", true, Infinity]);
  const defaults = loadConfig(keys, {});
  assert.deepEqual([defaults.provider, defaults.model, defaults.showThinking, defaults.maxTurns], ["anthropic", "claude-sonnet-5-5", false, 10]);
});

test("environment variables win over saved settings", () => {
  const saved = { provider: "deepseek" as const, models: { deepseek: "deepseek-v4-pro", anthropic: "claude-haiku-5-5" }, showThinking: true, maxTurns: 50 };
  const c = loadConfig({ ...keys, PROVIDER: "anthropic", SHOW_THINKING: "0", MAX_TURNS: "5" }, saved);
  assert.deepEqual([c.provider, c.model, c.showThinking, c.maxTurns], ["anthropic", "claude-haiku-5-5", false, 5], "saved anthropic model still used");
  assert.equal(loadConfig({ ...keys, MODEL: "deepseek-flash" }, saved).model, "deepseek-flash", "MODEL applies to the saved starting provider");
});

test("a MODEL that doesn't fit the saved provider says where the provider came from", () => {
  assert.throws(
    () => loadConfig({ ...keys, MODEL: "claude-haiku-5-5" }, { provider: "deepseek" }),
    /MODEL must be one of deepseek-flash, deepseek-v4-pro for deepseek, the default provider saved with \/defaults \(set PROVIDER to start with another\) \(got "claude-haiku-5-5"\)/,
  );
  assert.equal(loadConfig({ ...keys, PROVIDER: "anthropic", MODEL: "claude-haiku-5-5" }, { provider: "deepseek" }).model, "claude-haiku-5-5");
});

test("switching provider uses that provider's saved model unless one was used this session", async () => {
  const env = { ...keys };
  const saved = { models: { deepseek: "deepseek-v4-pro" } };
  const c = loadConfig(env, saved);
  const ctx = {
    env,
    current: { provider: c.provider, apiKey: c.apiKey, baseUrl: c.baseUrl, model: c.model },
    messages: [],
    lastModel: new Map<Provider, string>(),
    settings: saved,
  };
  assert.equal((await runProviderCommand("deepseek", ctx)).settings?.model, "deepseek-v4-pro");
  ctx.lastModel.set("deepseek", "deepseek-flash");
  assert.equal((await runProviderCommand("deepseek", ctx)).settings?.model, "deepseek-flash");
});

// --- /defaults --------------------------------------------------------------------

function ctx(env: NodeJS.ProcessEnv = keys, saved = {}): DefaultsCommandContext {
  return {
    env,
    path: join(dir, `h${++n}.json`),
    saved,
    current: { provider: "deepseek", model: "deepseek-v4-pro", showThinking: true, maxTurns: Infinity },
    lastModel: new Map<Provider, string>([["anthropic", "claude-haiku-5-5"]]),
  };
}

test("/defaults shows each starting value and where it comes from", async () => {
  const c = ctx({ ...keys, MAX_TURNS: "20" }, { provider: "deepseek", maxTurns: 40 });
  const out = (await runDefaultsCommand("", c)).output;
  assert.match(out, /^Defaults for the next start \(saved in .*h\d+\.json\):/);
  assert.match(out, /\n  provider  deepseek +.*h\d+\.json\n/);
  assert.match(out, /\n  model     anthropic: claude-sonnet-5-5 +built-in\n/);
  assert.match(out, /\n            deepseek: deepseek-flash +built-in\n/);
  assert.match(out, /\n  thinking  off +built-in\n/);
  assert.match(out, /\n  turns     20 model call\(s\) +MAX_TURNS in the environment \(overrides "40 model call\(s\)" in .*\)\n/);
  assert.match(out, /\nThis session: deepseek \/ deepseek-v4-pro · thinking on · turns unlimited\n/);
  assert.match((await runDefaultsCommand("", ctx())).output, /nothing saved; .* does not exist/);
});

test("/defaults save writes this session's settings, keeping other providers' models", async () => {
  const c = ctx(keys, { models: { anthropic: "claude-opus-5-5" } });
  const r = await runDefaultsCommand("save", c);
  assert.equal(r.output, `Saved to ${c.path}: deepseek / deepseek-v4-pro (anthropic: claude-haiku-5-5) · thinking on · turns unlimited.`);
  assert.deepEqual(r.saved, { provider: "deepseek", models: { anthropic: "claude-haiku-5-5", deepseek: "deepseek-v4-pro" }, showThinking: true, maxTurns: Infinity });
  assert.deepEqual(await loadSettings(c.path), r.saved);
  assert.deepEqual((await readdir(dir)).filter((f) => f.includes(".tmp-")), [], "no temp file left");
  assert.doesNotMatch(await readFile(c.path, "utf8"), /sk-/, "no keys in the file");
});

test("/defaults save warns when an environment variable will still win", async () => {
  const c = ctx({ ...keys, PROVIDER: "anthropic", SHOW_THINKING: "1" });
  const out = (await runDefaultsCommand("save", c)).output;
  assert.match(out, /\nNote: PROVIDER is set in the environment \(\.env or your shell\), which still wins over .* at startup\./);
  assert.match(out, /\nNote: SHOW_THINKING is set in the environment/);
});

test("/defaults clear removes the file; unknown subcommands show help", async () => {
  const c = ctx();
  await runDefaultsCommand("save", c);
  const r = await runDefaultsCommand("clear", c);
  assert.deepEqual(r.saved, {});
  assert.match(r.output, /^Removed .*\. Next start: anthropic \/ claude-sonnet-5-5 · thinking off · turns 10/);
  assert.deepEqual(await loadSettings(c.path), {});
  assert.match((await runDefaultsCommand("clear", c)).output, /^Removed/, "clearing twice is fine");
  const help = await runDefaultsCommand("frob", c);
  assert.equal(help.saved, undefined);
  assert.match(help.output, /^Unknown \/defaults command "frob"\.\n\n\/defaults /);
});
