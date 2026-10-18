import { DEFAULT_MAX_TOKENS, PROVIDER_NAMES, PROVIDERS, startProvider } from "./config.ts";
import type { Provider } from "./config.ts";
import { clearSettings, saveSettings } from "./settings.ts";
import type { Settings } from "./settings.ts";
import { describeTurns } from "./turns_command.ts";

export interface SessionSettings {
  provider: Provider;
  model: string;
  showThinking: boolean;
  maxTurns: number;
  maxTokens: number;
}

export interface DefaultsCommandContext {
  env: NodeJS.ProcessEnv;
  path: string; // the settings file
  saved: Settings; // what the file holds now
  current: SessionSettings; // what this session is using
  lastModel: Map<Provider, string>; // the model last used with each provider this session
}

export interface DefaultsCommandResult {
  output: string;
  saved?: Settings; // the file's new contents, when it changed
}

export const DEFAULTS_HELP = [
  "/defaults         show what the harness starts with, and where each setting comes from",
  "/defaults save    make this session's provider, models, thinking, turns and max tokens the defaults",
  "/defaults clear   remove the saved defaults (built-in defaults apply again)",
].join("\n");

export async function runDefaultsCommand(args: string, ctx: DefaultsCommandContext): Promise<DefaultsCommandResult> {
  const sub = args.trim().toLowerCase();
  try {
    switch (sub) {
      case "":
      case "show":
        return { output: describeDefaults(ctx) };
      case "save": {
        const { current } = ctx;
        const models: Partial<Record<Provider, string>> = { ...ctx.saved.models };
        for (const [p, m] of ctx.lastModel) models[p] = m;
        models[current.provider] = current.model;
        const next: Settings = {
          provider: current.provider,
          models,
          showThinking: current.showThinking,
          maxTurns: current.maxTurns,
          maxTokens: current.maxTokens,
        };
        await saveSettings(ctx.path, next);
        const others = PROVIDER_NAMES.filter((p) => p !== current.provider && models[p]).map((p) => `${p}: ${models[p]}`);
        const lines = [
          `Saved to ${ctx.path}: ${current.provider} / ${current.model}${others.length ? ` (${others.join(", ")})` : ""} · ` +
            `thinking ${current.showThinking ? "on" : "off"} · turns ${describeTurns(current.maxTurns)} · ` +
            `max tokens ${current.maxTokens.toLocaleString("en-US")}.`,
          ...overriddenBy({ env: ctx.env, saved: next }).map((o) => `Note: ${o}, which still wins over ${ctx.path} at startup.`),
        ];
        return { output: lines.join("\n"), saved: next };
      }
      case "clear": {
        await clearSettings(ctx.path);
        const built = PROVIDERS.anthropic;
        return {
          output: `Removed ${ctx.path}. Next start: anthropic / ${built.defaultModel} · thinking off · turns 10 · max tokens ${DEFAULT_MAX_TOKENS.toLocaleString("en-US")}, unless the environment says otherwise.`,
          saved: {},
        };
      }
      default:
        return { output: `Unknown /defaults command "${sub}".\n\n${DEFAULTS_HELP}` };
    }
  } catch (err) {
    return { output: `Not changed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

type Source = "environment" | "saved" | "built-in";

interface Resolved {
  value: string;
  source: Source;
  envName?: string; // the variable, when the environment decides
  overrides?: string; // the saved value the environment beats
}

// What each setting starts as next time, and why.
function resolve(ctx: Pick<DefaultsCommandContext, "env" | "saved">) {
  const { env, saved } = ctx;
  const pick = (envName: string, envValue: string | undefined, savedValue: string | undefined, builtIn: string): Resolved => {
    if (envValue !== undefined && envValue.trim() !== "") {
      return { value: envValue.trim(), source: "environment", envName, ...(savedValue !== undefined ? { overrides: savedValue } : {}) };
    }
    if (savedValue !== undefined) return { value: savedValue, source: "saved" };
    return { value: builtIn, source: "built-in" };
  };
  const start = startProvider(env, saved);
  const models = Object.fromEntries(
    PROVIDER_NAMES.map((p) => {
      const envName = p === start && env.MODEL ? "MODEL" : p === "anthropic" && env.ANTHROPIC_MODEL ? "ANTHROPIC_MODEL" : undefined;
      return [p, pick(envName ?? "", envName ? env[envName] : undefined, saved.models?.[p], PROVIDERS[p].defaultModel)];
    }),
  ) as Record<Provider, Resolved>;
  const onOff = (b: boolean | undefined) => (b === undefined ? undefined : b ? "on" : "off");
  return {
    provider: pick("PROVIDER", env.PROVIDER?.toLowerCase(), saved.provider, "anthropic"),
    models,
    thinking: pick("SHOW_THINKING", env.SHOW_THINKING, onOff(saved.showThinking), "off"),
    turns: pick("MAX_TURNS", turnsText(env.MAX_TURNS), saved.maxTurns === undefined ? undefined : describeTurns(saved.maxTurns), describeTurns(10)),
    maxTokens: pick(
      "MAX_TOKENS",
      /^\d+$/.test(env.MAX_TOKENS?.trim() ?? "") ? Number(env.MAX_TOKENS).toLocaleString("en-US") : env.MAX_TOKENS,
      saved.maxTokens?.toLocaleString("en-US"),
      DEFAULT_MAX_TOKENS.toLocaleString("en-US"),
    ),
  };
}

// "20" -> "20 model call(s)", matching how saved and built-in values read.
function turnsText(raw: string | undefined): string | undefined {
  const t = raw?.trim().toLowerCase();
  if (t === undefined || t === "") return undefined;
  if (t === "off" || t === "unlimited") return "unlimited";
  return /^\d+$/.test(t) ? describeTurns(Number(t)) : t;
}

function label(r: Resolved, path: string): string {
  if (r.source === "environment") return `${r.envName} in the environment${r.overrides !== undefined ? ` (overrides "${r.overrides}" in ${path})` : ""}`;
  return r.source === "saved" ? path : "built-in";
}

// Environment variables that decide a setting the file also holds.
function overriddenBy(ctx: Pick<DefaultsCommandContext, "env" | "saved">): string[] {
  const r = resolve(ctx);
  return [r.provider, ...Object.values(r.models), r.thinking, r.turns, r.maxTokens]
    .filter((x) => x.source === "environment" && x.overrides !== undefined)
    .map((x) => `${x.envName} is set in the environment (.env or your shell)`);
}

export function describeDefaults(ctx: DefaultsCommandContext): string {
  const r = resolve(ctx);
  const values = [r.provider.value, ...PROVIDER_NAMES.map((p) => `${p}: ${r.models[p].value}`), r.thinking.value, r.turns.value, r.maxTokens.value];
  const col = Math.max(...values.map((v) => v.length)) + 3;
  const row = (name: string, value: string, from: string) => `  ${name.padEnd(12)}${value.padEnd(col)}${from}`;
  const c = ctx.current;
  return [
    `Defaults for the next start (${Object.keys(ctx.saved).length ? `saved in ${ctx.path}` : `nothing saved; ${ctx.path} does not exist`}):`,
    row("provider", r.provider.value, label(r.provider, ctx.path)),
    ...PROVIDER_NAMES.map((p) => row(p === PROVIDER_NAMES[0] ? "model" : "", `${p}: ${r.models[p].value}`, label(r.models[p], ctx.path))),
    row("thinking", r.thinking.value, label(r.thinking, ctx.path)),
    row("turns", r.turns.value, label(r.turns, ctx.path)),
    row("max tokens", r.maxTokens.value, label(r.maxTokens, ctx.path)),
    `This session: ${c.provider} / ${c.model} · thinking ${c.showThinking ? "on" : "off"} · turns ${describeTurns(c.maxTurns)} · max tokens ${c.maxTokens.toLocaleString("en-US")}`,
    "/defaults save makes this session's settings the defaults; /defaults clear removes them.",
  ].join("\n");
}
