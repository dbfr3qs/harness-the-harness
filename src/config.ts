import { join } from "node:path";
import type { Settings } from "./settings.ts";

export type Provider = "anthropic" | "deepseek";

export interface ProviderInfo {
  label: string; // for messages: "Anthropic API error: ..."
  keyVar: string; // the env var holding this provider's key
  baseUrl: string;
  defaultModel: string;
  // Offered by /model. With `strict`, these are the only IDs accepted: DeepSeek silently maps
  // unknown names to another model, so a typo would run (and bill) a model you didn't ask for.
  // contextWindow, where known in advance; Anthropic's is looked up from its models API instead.
  models: readonly { id: string; note?: string; contextWindow?: number }[];
  strict: boolean;
}

// Both speak the Anthropic Messages API; DeepSeek serves it under /anthropic.
export const PROVIDERS: Record<Provider, ProviderInfo> = {
  anthropic: {
    label: "Anthropic",
    keyVar: "ANTHROPIC_API_KEY",
    baseUrl: "https://api.anthropic.com",
    defaultModel: "claude-sonnet-5-5",
    models: [
      { id: "claude-sonnet-5-5", note: "default" },
      { id: "claude-opus-5-5" },
      { id: "claude-haiku-5-5", note: "fastest, cheapest" },
      { id: "claude-fable-5-1" },
    ],
    strict: false, // any model ID works; Anthropic rejects unknown ones with a clear error
  },
  deepseek: {
    label: "DeepSeek",
    keyVar: "DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com/anthropic",
    defaultModel: "deepseek-flash",
    models: [
      // 1M-token context for both, per api-docs.deepseek.com/quick_start/pricing.
      { id: "deepseek-flash", note: "default", contextWindow: 1_000_000 },
      { id: "deepseek-v4-pro", note: "larger, pricier", contextWindow: 1_000_000 },
    ],
    strict: true,
  },
};

export interface Config {
  provider: Provider;
  apiKey: string;
  secrets: string[]; // every API key in the environment, scrubbed from transcripts
  baseUrl: string;
  model: string;
  maxTokens: number;
  maxTurns: number; // Infinity when unlimited
  timeoutMs: number;
  maxRetries: number;
  stream: boolean;
  showThinking: boolean; // print the model's readable thinking (toggled with /thinking)
  contextWindow?: number; // CONTEXT_WINDOW: overrides the model's context window for the meter
  maxToolOutputChars: number;
  workspaceRoot: string;
  transcriptPath: string;
  webPolicyPath: string;
  webPolicyRequired: boolean; // WEB_POLICY was set explicitly, so a missing file is an error
}

export class ConfigError extends Error {}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 1): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new ConfigError(`${name} must be an integer >= ${min} (got "${raw}")`);
  }
  return n;
}

// A whole number of 1 or more, or "unlimited" ("off" also works) for no limit.
function maxTurns(env: NodeJS.ProcessEnv, fallback: number): number {
  const raw = env.MAX_TURNS?.trim().toLowerCase();
  if (raw === "unlimited" || raw === "off") return Infinity;
  if (raw === undefined || raw === "") return fallback;
  try {
    return positiveInt(env, "MAX_TURNS", fallback);
  } catch {
    throw new ConfigError(`MAX_TURNS must be an integer >= 1 or "unlimited" (got "${env.MAX_TURNS}")`);
  }
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new ConfigError(`${name} must be true or false (got "${env[name]}")`);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export const PROVIDER_NAMES = Object.keys(PROVIDERS) as Provider[];

export function isProvider(name: string): name is Provider {
  return Object.hasOwn(PROVIDERS, name);
}

export type ProviderSettings = Pick<Config, "provider" | "apiKey" | "baseUrl" | "model">;

/** Throws ConfigError if `model` isn't one the provider accepts. */
export function checkModel(provider: Provider, model: string): void {
  const info = PROVIDERS[provider];
  if (info.strict && !info.models.some((m) => m.id === model)) {
    throw new ConfigError(
      `MODEL must be one of ${info.models.map((m) => m.id).join(", ")} for PROVIDER=${provider} (got "${model}")`,
    );
  }
}

/**
 * Key, base URL and model for `provider`. MODEL and BASE_URL belong to the starting provider, so
 * switching away and back restores them; the ANTHROPIC_ names belong to anthropic. Environment
 * variables win over saved settings (harness.json), which win over the built-in defaults.
 * Used at startup and by /provider and /model.
 */
export function providerSettings(
  env: NodeJS.ProcessEnv,
  provider: Provider,
  model?: string,
  settings: Settings = {},
): ProviderSettings {
  const info = PROVIDERS[provider];
  const apiKey = env[info.keyVar]?.trim();
  if (!apiKey) {
    throw new ConfigError(
      `${info.keyVar} is not set (PROVIDER=${provider}). Add it to .env in the project root or export it in your shell.`,
    );
  }
  const own = (name: string) => (provider === startProvider(env, settings) ? env[name] : undefined);
  const legacy = (name: string) => (provider === "anthropic" ? env[`ANTHROPIC_${name}`] : undefined);
  const chosen = (model || own("MODEL") || legacy("MODEL") || settings.models?.[provider] || info.defaultModel).trim();
  try {
    checkModel(provider, chosen);
  } catch (err) {
    // Say where the provider came from, when it wasn't PROVIDER: MODEL applies to the saved one.
    if (err instanceof ConfigError && !env.PROVIDER?.trim() && settings.provider === provider) {
      throw new ConfigError(
        err.message.replace(`for PROVIDER=${provider}`, `for ${provider}, the default provider saved with /defaults (set PROVIDER to start with another)`),
      );
    }
    throw err;
  }
  return {
    provider,
    apiKey,
    baseUrl: (own("BASE_URL") || legacy("BASE_URL") || info.baseUrl).replace(/\/+$/, ""),
    model: chosen,
  };
}

/** The provider to start with: PROVIDER, else the saved default, else anthropic. */
export function startProvider(env: NodeJS.ProcessEnv, settings: Settings = {}): Provider {
  const name = env.PROVIDER?.trim().toLowerCase() || settings.provider || "anthropic";
  if (!isProvider(name)) {
    throw new ConfigError(`PROVIDER must be one of ${PROVIDER_NAMES.join(", ")} (got "${env.PROVIDER}")`);
  }
  return name;
}

/** Whether `provider`'s key is set, so /provider can offer it. */
export function hasKey(env: NodeJS.ProcessEnv, provider: Provider): boolean {
  return Boolean(env[PROVIDERS[provider].keyVar]?.trim());
}

// Throws ConfigError on a missing key or invalid values; callers decide how to exit.
export function loadConfig(env: NodeJS.ProcessEnv = process.env, saved: Settings = {}): Config {
  const settings = providerSettings(env, startProvider(env, saved), undefined, saved);
  const secrets = Object.values(PROVIDERS)
    .map((p) => env[p.keyVar]?.trim())
    .filter((k): k is string => Boolean(k));

  return {
    ...settings,
    secrets,
    maxTokens: positiveInt(env, "MAX_TOKENS", 4096),
    maxTurns: maxTurns(env, saved.maxTurns ?? 10),
    timeoutMs: positiveInt(env, "TIMEOUT_MS", 120_000),
    maxRetries: positiveInt(env, "MAX_RETRIES", 3, 0),
    stream: bool(env, "STREAM", true),
    showThinking: bool(env, "SHOW_THINKING", saved.showThinking ?? false),
    ...(env.CONTEXT_WINDOW?.trim() ? { contextWindow: positiveInt(env, "CONTEXT_WINDOW", 0) } : {}),
    maxToolOutputChars: positiveInt(env, "MAX_TOOL_OUTPUT_CHARS", 8000),
    workspaceRoot: env.WORKSPACE_ROOT || process.cwd(),
    transcriptPath: env.TRANSCRIPT_PATH || join("transcripts", `${timestamp()}.jsonl`),
    webPolicyPath: env.WEB_POLICY || "web-policy.json",
    webPolicyRequired: Boolean(env.WEB_POLICY),
  };
}
