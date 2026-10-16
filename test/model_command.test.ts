import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import type { Provider } from "../src/config.ts";
import type { MenuItem } from "../src/menu.ts";
import { removeThinking, runModelCommand, runProviderCommand } from "../src/model_command.ts";
import type { ModelCommandContext } from "../src/model_command.ts";
import type { Message } from "../src/types.ts";

const both = { ANTHROPIC_API_KEY: "sk-ant-A", DEEPSEEK_API_KEY: "sk-D" };

function ctx(env: NodeJS.ProcessEnv = both, picks: unknown[] = [], messages: Message[] = []) {
  const c = loadConfig(env);
  const menus: { title: string; items: MenuItem<unknown>[]; initial: number }[] = [];
  const context: ModelCommandContext = {
    env,
    current: { provider: c.provider, apiKey: c.apiKey, baseUrl: c.baseUrl, model: c.model },
    messages,
    lastModel: new Map<Provider, string>(),
    choose: async (title, items, initial) => {
      menus.push({ title, items: items as MenuItem<unknown>[], initial });
      return picks.shift() as never;
    },
  };
  // Applies a result the way the REPL does.
  const run = async (cmd: typeof runProviderCommand, args: string) => {
    const r = await cmd(args, context);
    if (r.settings) context.current = r.settings;
    return r;
  };
  return { context, menus, provider: (a = "") => run(runProviderCommand, a), model: (a = "") => run(runModelCommand, a) };
}

const conversation = (): Message[] => [
  { role: "user", content: "time?" },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "call it", signature: "sig-1" },
      { type: "tool_use", id: "call_1", name: "get_time", input: {} },
    ],
  },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "14:00" }] },
  { role: "assistant", content: [{ type: "thinking", thinking: "done", signature: "sig-2" }] },
];

test("/provider opens a menu of providers, starting on the current one", async () => {
  const t = ctx(both, ["deepseek"]);
  const r = await t.provider();
  assert.equal(t.menus[0]!.initial, 0);
  assert.deepEqual(t.menus[0]!.items.map((i) => [i.value, i.hint, i.disabled]), [
    ["anthropic", "Anthropic · current (claude-sonnet-5-5)", undefined],
    ["deepseek", "DeepSeek", undefined],
  ]);
  assert.equal(r.output, "Provider: deepseek / deepseek-flash.");
  assert.deepEqual(r.settings, { provider: "deepseek", apiKey: "sk-D", baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-flash" });
});

test("a provider without a key is shown but disabled, and naming it explains why", async () => {
  const t = ctx({ ANTHROPIC_API_KEY: "sk-ant-A" }, [undefined]);
  assert.match((await t.provider()).output, /^Unchanged: anthropic \/ claude-sonnet-5-5$/);
  assert.equal(t.menus[0]!.items[1]!.disabled, "DeepSeek · set DEEPSEEK_API_KEY in .env to use");
  const r = await t.provider("deepseek");
  assert.equal(r.settings, undefined);
  assert.match(r.output, /^Not changed: DEEPSEEK_API_KEY is not set/);
});

test("/provider <name> switches directly; unknown and current names change nothing", async () => {
  const t = ctx();
  assert.match((await t.provider("gemini")).output, /^Unknown provider "gemini"\. Choose one of: anthropic, deepseek$/);
  assert.match((await t.provider("anthropic")).output, /^Already using anthropic/);
  assert.equal((await t.provider("DeepSeek")).settings?.provider, "deepseek");
});

test("switching provider keeps history but removes thinking blocks", async () => {
  const messages = conversation();
  const t = ctx({ ...both, PROVIDER: "deepseek" }, [], messages);
  const r = await t.provider("anthropic");
  assert.equal(r.thinkingRemoved, 2);
  assert.match(r.output, /History kept \(4 message\(s\)\); 2 thinking block\(s\) removed/);
  assert.deepEqual(messages[1], { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "get_time", input: {} }] });
  assert.deepEqual(messages[3], { role: "assistant", content: [{ type: "text", text: "(thinking omitted)" }] });
  assert.equal(removeThinking(messages), 0, "nothing left to remove");
});

test("switching back to a provider restores the model last used with it", async () => {
  const t = ctx();
  await t.model("claude-haiku-5-5");
  await t.provider("deepseek");
  await t.model("deepseek-v4-pro");
  assert.equal((await t.provider("anthropic")).settings?.model, "claude-haiku-5-5");
  assert.equal((await t.provider("deepseek")).settings?.model, "deepseek-v4-pro");
});

test("MODEL and BASE_URL from the environment apply to their own provider only", async () => {
  const t = ctx({ ...both, MODEL: "claude-opus-5-5", BASE_URL: "https://proxy.test" });
  assert.deepEqual(t.context.current.baseUrl, "https://proxy.test");
  const ds = await t.provider("deepseek");
  assert.equal(ds.settings?.model, "deepseek-flash");
  assert.equal(ds.settings?.baseUrl, "https://api.deepseek.com/anthropic");
  const back = await t.provider("anthropic");
  assert.equal(back.settings?.baseUrl, "https://proxy.test");
  assert.equal(back.settings?.model, "claude-opus-5-5");
});

test("/model lists the provider's models; Anthropic also takes any ID, DeepSeek only its own", async () => {
  const t = ctx(both, ["claude-opus-5-5"]);
  const r = await t.model();
  assert.match(t.menus[0]!.title, /or \/model <id> for any Anthropic model/);
  assert.deepEqual(t.menus[0]!.items.map((i) => [i.value, i.hint]), [
    ["claude-sonnet-5-5", "default · current"],
    ["claude-opus-5-5", ""],
    ["claude-haiku-5-5", "fastest, cheapest"],
    ["claude-fable-5-1", ""],
  ]);
  assert.equal(r.output, "Model: anthropic / claude-opus-5-5. History kept.");
  assert.equal((await t.model("claude-opus-4-8")).settings?.model, "claude-opus-4-8");

  const d = ctx({ ...both, PROVIDER: "deepseek" });
  const bad = await d.model("claude-opus-5-5");
  assert.equal(bad.settings, undefined);
  assert.match(bad.output, /^Not changed: the model must be one of deepseek-flash, deepseek-v4-pro/);
  assert.match((await d.model("deepseek-flash")).output, /^Already using deepseek \/ deepseek-flash$/);
});

test("a custom current model appears in the /model menu", async () => {
  const t = ctx({ ...both, MODEL: "claude-opus-4-8" }, [undefined]);
  assert.match((await t.model()).output, /^Unchanged/);
  assert.deepEqual(t.menus[0]!.items.at(-1), { label: "claude-opus-4-8", value: "claude-opus-4-8", hint: "current" });
  assert.equal(t.menus[0]!.initial, 4);
});

test("without a terminal, the commands print a list and how to switch", async () => {
  const t = ctx();
  delete t.context.choose;
  assert.equal(
    (await t.provider()).output,
    "Providers:\n  * anthropic  (Anthropic · current (claude-sonnet-5-5))\n    deepseek  (DeepSeek)\nUse /provider <name> to switch.",
  );
  const models = (await t.model()).output;
  assert.match(models, /^Anthropic models:\n  \* claude-sonnet-5-5  \(default · current\)\n/);
  assert.match(models, /\nUse \/model <id> \(any Anthropic model ID works\) to switch\.$/);
});
