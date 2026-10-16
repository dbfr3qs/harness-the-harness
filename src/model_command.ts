import { ConfigError, checkModel, hasKey, isProvider, PROVIDER_NAMES, PROVIDERS, providerSettings } from "./config.ts";
import type { Provider, ProviderSettings } from "./config.ts";
import type { MenuItem } from "./menu.ts";
import type { Message } from "./types.ts";

export interface ModelCommandContext {
  env: NodeJS.ProcessEnv;
  current: ProviderSettings;
  /** Conversation history; a provider switch removes thinking blocks from it in place. */
  messages: Message[];
  /** The model last used with each provider this session, restored when switching back. */
  lastModel: Map<Provider, string>;
  /** Shows a menu and resolves with the choice (undefined if cancelled); absent when input isn't a terminal. */
  choose?: <T>(title: string, items: MenuItem<T>[], initial: number) => Promise<T | undefined>;
}

export interface ModelCommandResult {
  output: string;
  settings?: ProviderSettings; // set when the provider or model changed
  thinkingRemoved?: number;
}

export async function runProviderCommand(args: string, ctx: ModelCommandContext): Promise<ModelCommandResult> {
  const { current } = ctx;
  let name = args.trim().toLowerCase();
  if (!name) {
    const items: MenuItem<Provider>[] = PROVIDER_NAMES.map((p) => ({
      label: p,
      value: p,
      hint: `${PROVIDERS[p].label}${p === current.provider ? ` · current (${current.model})` : ""}`,
      ...(hasKey(ctx.env, p) ? {} : { disabled: `${PROVIDERS[p].label} · set ${PROVIDERS[p].keyVar} in .env to use` }),
    }));
    if (!ctx.choose) return { output: listing("Providers", items, current.provider, "/provider <name>") };
    const chosen = await ctx.choose("Provider", items, PROVIDER_NAMES.indexOf(current.provider));
    if (!chosen) return { output: `Unchanged: ${current.provider} / ${current.model}` };
    name = chosen;
  }

  if (!isProvider(name)) return { output: `Unknown provider "${name}". Choose one of: ${PROVIDER_NAMES.join(", ")}` };
  if (name === current.provider) return { output: `Already using ${current.provider} / ${current.model}` };

  let settings: ProviderSettings;
  try {
    settings = providerSettings(ctx.env, name, ctx.lastModel.get(name));
  } catch (err) {
    if (err instanceof ConfigError) return { output: `Not changed: ${err.message}` };
    throw err;
  }
  ctx.lastModel.set(current.provider, current.model);
  ctx.lastModel.set(settings.provider, settings.model);

  // Thinking blocks carry a signature only the provider that wrote them accepts (Claude returns
  // 400 for DeepSeek's), so they can't follow the conversation across. Everything else can.
  const thinkingRemoved = removeThinking(ctx.messages);
  const history = ctx.messages.length === 0
    ? ""
    : ` History kept (${ctx.messages.length} message(s))${thinkingRemoved ? `; ${thinkingRemoved} thinking block(s) removed, since only the provider that wrote them accepts them` : ""}.`;
  return { output: `Provider: ${settings.provider} / ${settings.model}.${history}`, settings, thinkingRemoved };
}

export async function runModelCommand(args: string, ctx: ModelCommandContext): Promise<ModelCommandResult> {
  const { current } = ctx;
  const info = PROVIDERS[current.provider];
  let model = args.trim();
  if (!model) {
    const ids = info.models.map((m) => m.id);
    const items: MenuItem<string>[] = info.models.map((m) => ({
      label: m.id,
      value: m.id,
      hint: [m.note, m.id === current.model ? "current" : ""].filter(Boolean).join(" · "),
    }));
    if (!ids.includes(current.model)) items.push({ label: current.model, value: current.model, hint: "current" });
    const typed = info.strict ? "" : ` (or /model <id> for any ${info.label} model)`;
    if (!ctx.choose) {
      const any = info.strict ? "" : ` (any ${info.label} model ID works)`;
      return { output: listing(`${info.label} models`, items, current.model, `/model <id>${any}`) };
    }
    const chosen = await ctx.choose(`${info.label} model${typed}`, items, items.findIndex((i) => i.value === current.model));
    if (!chosen) return { output: `Unchanged: ${current.provider} / ${current.model}` };
    model = chosen;
  }

  if (model === current.model) return { output: `Already using ${current.provider} / ${current.model}` };
  try {
    checkModel(current.provider, model);
  } catch (err) {
    if (err instanceof ConfigError) return { output: `Not changed: ${err.message.replace(/^MODEL/, "the model")}` };
    throw err;
  }
  ctx.lastModel.set(current.provider, model);
  return { output: `Model: ${current.provider} / ${model}. History kept.`, settings: { ...current, model } };
}

/** Removes thinking blocks from assistant messages in place; returns how many were removed. */
export function removeThinking(messages: Message[]): number {
  let removed = 0;
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const kept = m.content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
    removed += m.content.length - kept.length;
    // An assistant turn can't be empty, so a turn that was only thinking keeps a placeholder.
    m.content = kept.length ? kept : [{ type: "text", text: "(thinking omitted)" }];
  }
  return removed;
}

function listing<T>(title: string, items: MenuItem<T>[], current: T, usage: string): string {
  const lines = items.map((i) => `  ${i.value === current ? "*" : " "} ${i.label}${i.disabled ? `  (${i.disabled})` : i.hint ? `  (${i.hint})` : ""}`);
  return `${title}:\n${lines.join("\n")}\nUse ${usage} to switch.`;
}
