import { join } from "node:path";

export interface Config {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  maxTurns: number;
  timeoutMs: number;
  maxRetries: number;
  stream: boolean;
  maxToolOutputChars: number;
  workspaceRoot: string;
  transcriptPath: string;
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

// Throws ConfigError on a missing key or invalid values; callers decide how to exit.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new ConfigError(
      "ANTHROPIC_API_KEY is not set. Add it to .env in the project root or export it in your shell.",
    );
  }
  return {
    apiKey,
    baseUrl: (env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, ""),
    model: env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
    maxTokens: positiveInt(env, "MAX_TOKENS", 4096),
    maxTurns: positiveInt(env, "MAX_TURNS", 10),
    timeoutMs: positiveInt(env, "TIMEOUT_MS", 120_000),
    maxRetries: positiveInt(env, "MAX_RETRIES", 3, 0),
    stream: bool(env, "STREAM", true),
    maxToolOutputChars: positiveInt(env, "MAX_TOOL_OUTPUT_CHARS", 8000),
    workspaceRoot: env.WORKSPACE_ROOT || process.cwd(),
    transcriptPath: env.TRANSCRIPT_PATH || join("transcripts", `${timestamp()}.jsonl`),
  };
}
