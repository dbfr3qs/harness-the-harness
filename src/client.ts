import type { Config } from "./config.ts";
import type { MessageResponse, ModelFn, ModelRequest } from "./types.ts";

export type ClientConfig = Pick<
  Config,
  "apiKey" | "baseUrl" | "model" | "maxTokens" | "timeoutMs" | "maxRetries"
>;

export interface ClientHooks {
  onRequest?: (body: unknown) => void; // request body only, never headers
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
}

export interface ClientDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE_STATUS = new Set([429, 500, 529]);
const BASE_DELAY_MS = 500;

type Attempt =
  | { kind: "ok"; response: MessageResponse }
  | { kind: "retry"; reason: string; retryAfterMs?: number };

export function createAnthropicClient(
  config: ClientConfig,
  hooks: ClientHooks = {},
  deps: ClientDeps = {},
): ModelFn {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const url = `${config.baseUrl}/v1/messages`;

  // Belt and braces: no error message leaves this module containing the key.
  const redact = (s: string) => s.split(config.apiKey).join("[redacted]");

  async function attempt(payload: string): Promise<Attempt> {
    let res: Response;
    let text: string;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: {
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: payload,
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      return { kind: "retry", reason: describeNetworkError(err, config.timeoutMs) };
    }

    if (res.ok) return { kind: "ok", response: parseResponse(text) };

    const detail = `HTTP ${res.status}${errorDetail(text)}`;
    if (RETRYABLE_STATUS.has(res.status)) {
      return { kind: "retry", reason: detail, retryAfterMs: parseRetryAfter(res.headers.get("retry-after")) };
    }
    const hint = res.status === 401 ? " (check ANTHROPIC_API_KEY)" : "";
    throw new Error(`Anthropic API error: ${detail}${hint}`);
  }

  return async function callModel(req: ModelRequest): Promise<MessageResponse> {
    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: config.maxTokens,
      system: req.system,
      messages: req.messages,
    };
    if (req.tools.length > 0) body.tools = req.tools;
    hooks.onRequest?.(body);
    const payload = JSON.stringify(body);

    for (let n = 0; ; n++) {
      let result: Attempt;
      try {
        result = await attempt(payload);
      } catch (err) {
        throw new Error(redact(err instanceof Error ? err.message : String(err)));
      }
      if (result.kind === "ok") return result.response;

      if (n >= config.maxRetries) {
        throw new Error(redact(`Anthropic API request failed after ${n + 1} attempt(s): ${result.reason}`));
      }
      const delayMs = result.retryAfterMs ?? backoff(n);
      hooks.onRetry?.({ attempt: n + 1, delayMs, reason: redact(result.reason) });
      await sleep(delayMs);
    }
  };
}

function backoff(n: number): number {
  const base = BASE_DELAY_MS * 2 ** n;
  return Math.round(base * (0.5 + Math.random())); // jitter: 0.5x to 1.5x
}

// retry-after is either delay-seconds or an HTTP date.
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function describeNetworkError(err: unknown, timeoutMs: number): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return `timed out after ${timeoutMs} ms`;
    const cause = err.cause instanceof Error ? `: ${err.cause.message}` : "";
    return `network error: ${err.message}${cause}`;
  }
  return `network error: ${String(err)}`;
}

// Formats " <error.type>: <error.message>" from an API error body, or a short raw snippet.
function errorDetail(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { type?: unknown; message?: unknown } };
    const e = parsed?.error;
    if (e && (typeof e.type === "string" || typeof e.message === "string")) {
      return ` ${String(e.type ?? "unknown_error")}: ${String(e.message ?? "")}`;
    }
  } catch {
    // fall through to raw snippet
  }
  const snippet = text.trim().slice(0, 300);
  return snippet ? ` ${snippet}` : "";
}

function parseResponse(text: string): MessageResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Anthropic API returned invalid JSON: ${text.slice(0, 300)}`);
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { content?: unknown }).content)) {
    throw new Error(`Anthropic API response has no content array: ${text.slice(0, 300)}`);
  }
  return parsed as MessageResponse;
}
