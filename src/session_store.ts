import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { ConfigError } from "./config.ts";
import type { Config } from "./config.ts";
import type { LibrarySnapshot } from "./library/session.ts";
import type { PrivatePath } from "./tools/private_paths.ts";
import type { WebPolicy } from "./tools/web_policy.ts";
import type { Message } from "./types.ts";

export interface SessionState {
  version: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  unattended: boolean;
  settings: {
    provider: string;
    model: string;
    showThinking: boolean;
    maxTurns: number | "unlimited";
    maxTokens: number;
    contextWindow?: number;
  };
  transcriptPath: string;
  webPolicy: WebPolicy;
  messages: Message[];
  library?: LibrarySnapshot;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidSessionId(s: string): boolean {
  return typeof s === "string" && UUID.test(s);
}

/** `--resume <id>` | `--resume=<id>` | HARNESS_RESUME; the flag beats the env. */
export function resumeId(argv: string[], env: NodeJS.ProcessEnv): string | undefined {
  let raw: string | undefined;
  const i = argv.indexOf("--resume");
  if (i >= 0 && argv[i + 1]) raw = argv[i + 1];
  else {
    const eq = argv.find((a) => a.startsWith("--resume="));
    raw = eq ? eq.slice("--resume=".length) : env.HARNESS_RESUME || undefined;
  }
  if (raw === undefined || raw === "") return undefined;
  if (!isValidSessionId(raw)) throw new ConfigError(`--resume / HARNESS_RESUME must be a session id (a UUID), got "${raw}"`);
  return raw;
}

export function sessionFilePath(dir: string, id: string): string {
  if (!isValidSessionId(id)) throw new ConfigError(`invalid session id "${id}" (expected a UUID)`);
  return join(dir, `${id}.json`);
}

/** Saved sessions hold whole conversations: the model's file tools must neither read nor write the directory. */
export function sessionPrivatePaths(dir: string, workspaceRoot: string): PrivatePath[] {
  const abs = resolve(dir);
  const rel = relative(resolve(workspaceRoot), abs);
  const name = rel && !rel.startsWith("..") && !isAbsolute(rel) ? `${rel}/` : `${abs}/`;
  return [{ path: abs, name, holds: "saved sessions" }];
}

export interface SessionStore {
  save(state: SessionState): void;
  path(id: string): string;
  flush(): Promise<void>; // resolves once every queued save has been written (or failed)
}

/** Queued, atomic (temp file + rename), 0600, secrets scrubbed. Never throws; a failure warns once. */
export function createSessionStore(
  dir: string,
  opts: { secrets?: string[]; warn?: (m: string) => void } = {},
): SessionStore {
  const secrets = (opts.secrets ?? []).filter((s) => s.length > 0);
  const warn = opts.warn ?? ((m: string) => console.error(m));
  let warned = false;
  const onError = (err: unknown) => {
    if (warned) return;
    warned = true;
    const reason = err instanceof Error ? err.message : String(err);
    warn(`[warning: saving session to ${dir} failed: ${reason}; further warnings suppressed]`);
  };
  let queue: Promise<void> = Promise.resolve();

  return {
    path: (id) => sessionFilePath(dir, id),
    flush: () => queue,
    save(state) {
      let text: string;
      let file: string;
      try {
        file = sessionFilePath(dir, state.id);
        text = JSON.stringify(state);
      } catch (err) {
        onError(err);
        return;
      }
      for (const secret of secrets) text = text.split(secret).join("[redacted]");
      const body = text;
      queue = queue
        .then(async () => {
          await mkdir(dir, { recursive: true });
          const tmp = `${file}.${process.pid}.tmp`;
          await writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
          await chmod(tmp, 0o600);
          await rename(tmp, file);
        })
        .catch(onError);
    },
  };
}

export async function loadSession(dir: string, id: string): Promise<SessionState> {
  const file = sessionFilePath(dir, id);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    throw new ConfigError(`could not read session ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`session file ${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const o = data as Partial<SessionState> | null;
  if (!o || typeof o !== "object") throw new ConfigError(`session file ${file} is not a JSON object`);
  if (o.version !== 1) throw new ConfigError(`session file ${file} has unsupported version ${String(o.version)} (expected 1)`);
  if (o.id !== id) throw new ConfigError(`session file ${file} has id ${String(o.id)}, expected ${id}`);
  if (!o.settings || typeof o.settings !== "object") throw new ConfigError(`session file ${file} is missing settings`);
  if (!Array.isArray(o.messages) || !o.messages.every((m) => m && typeof m === "object" && "role" in m && "content" in m)) {
    throw new ConfigError(`session file ${file} has a malformed messages list`);
  }
  return o as SessionState;
}

export interface SessionStateParts {
  config: Pick<Config, "unattended" | "provider" | "model" | "showThinking" | "maxTurns" | "maxTokens" | "contextWindow" | "transcriptPath">;
  sessionId: string;
  createdAt?: string; // from the prior state when resuming
  now?: Date;
  policy: WebPolicy;
  messages: Message[];
  library?: LibrarySnapshot;
}

/** Assembles the on-disk state. Infinity never reaches JSON: an unlimited maxTurns is "unlimited". */
export function buildSessionState(parts: SessionStateParts): SessionState {
  const { config } = parts;
  const updatedAt = (parts.now ?? new Date()).toISOString();
  return {
    version: 1,
    id: parts.sessionId,
    createdAt: parts.createdAt ?? updatedAt,
    updatedAt,
    unattended: config.unattended,
    settings: {
      provider: config.provider,
      model: config.model,
      showThinking: config.showThinking,
      maxTurns: config.maxTurns === Infinity ? "unlimited" : config.maxTurns,
      maxTokens: config.maxTokens,
      ...(config.contextWindow !== undefined ? { contextWindow: config.contextWindow } : {}),
    },
    transcriptPath: config.transcriptPath,
    webPolicy: structuredClone(parts.policy),
    messages: structuredClone(parts.messages),
    ...(parts.library ? { library: parts.library } : {}),
  };
}
