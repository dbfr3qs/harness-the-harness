import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { ConfigError, PROVIDER_NAMES, PROVIDERS, isProvider } from "./config.ts";
import type { Provider } from "./config.ts";

export const DEFAULT_SETTINGS_PATH = "harness.json";

/**
 * Saved defaults: what the harness starts with when the environment doesn't say otherwise.
 * Never holds API keys; those stay in .env.
 */
export interface Settings {
  provider?: Provider;
  models?: Partial<Record<Provider, string>>; // the starting model for each provider
  showThinking?: boolean;
  maxTurns?: number; // Infinity for unlimited ("unlimited" in the file)
}

const KEYS = new Set(["provider", "models", "showThinking", "maxTurns"]);

/** Checks parsed JSON and returns Settings, or throws ConfigError naming the problem. */
export function parseSettings(json: unknown, source: string): Settings {
  const fail = (msg: string): never => {
    throw new ConfigError(`${source}: ${msg}`);
  };
  if (typeof json !== "object" || json === null || Array.isArray(json)) fail("must be a JSON object");
  const raw = json as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((k) => !KEYS.has(k));
  if (unknown.length) fail(`unknown setting(s) ${unknown.map((k) => `"${k}"`).join(", ")}; allowed: ${[...KEYS].join(", ")}`);

  const out: Settings = {};
  if (raw.provider !== undefined) {
    if (typeof raw.provider !== "string" || !isProvider(raw.provider)) fail(`"provider" must be one of ${PROVIDER_NAMES.join(", ")}`);
    out.provider = raw.provider as Provider;
  }
  if (raw.models !== undefined) {
    if (typeof raw.models !== "object" || raw.models === null || Array.isArray(raw.models)) fail('"models" must be an object');
    out.models = {};
    for (const [p, model] of Object.entries(raw.models as Record<string, unknown>)) {
      if (!isProvider(p)) fail(`"models" has unknown provider "${p}"; allowed: ${PROVIDER_NAMES.join(", ")}`);
      if (typeof model !== "string" || model.trim() === "") fail(`"models.${p}" must be a model ID`);
      const info = PROVIDERS[p as Provider];
      if (info.strict && !info.models.some((m) => m.id === model)) {
        fail(`"models.${p}" must be one of ${info.models.map((m) => m.id).join(", ")} (got "${model}")`);
      }
      out.models[p as Provider] = (model as string).trim();
    }
  }
  if (raw.showThinking !== undefined) {
    if (typeof raw.showThinking !== "boolean") fail('"showThinking" must be true or false');
    out.showThinking = raw.showThinking as boolean;
  }
  if (raw.maxTurns !== undefined) {
    const t = raw.maxTurns;
    if (t === "unlimited") out.maxTurns = Infinity;
    else if (typeof t === "number" && Number.isSafeInteger(t) && t >= 1) out.maxTurns = t;
    else fail('"maxTurns" must be a whole number of 1 or more, or "unlimited"');
  }
  return out;
}

/** Reads the settings file. A missing file means no saved defaults; a broken one is an error. */
export async function loadSettings(path: string): Promise<Settings> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new ConfigError(`could not read settings ${path}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  return parseSettings(json, path);
}

export function formatSettings(s: Settings): string {
  const out: Record<string, unknown> = {};
  if (s.provider) out.provider = s.provider;
  if (s.models && Object.keys(s.models).length) {
    // Providers in a fixed order, so saves don't reorder the file.
    out.models = Object.fromEntries(PROVIDER_NAMES.filter((p) => s.models![p]).map((p) => [p, s.models![p]]));
  }
  if (s.showThinking !== undefined) out.showThinking = s.showThinking;
  if (s.maxTurns !== undefined) out.maxTurns = Number.isFinite(s.maxTurns) ? s.maxTurns : "unlimited";
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** Writes atomically (temp file, then rename), so a crash can't leave half a file. */
export async function saveSettings(path: string, s: Settings): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, formatSettings(s), "utf8");
  await rename(tmp, path);
}

/** Deletes the settings file; a missing file is fine. */
export async function clearSettings(path: string): Promise<void> {
  await rm(path, { force: true });
}
