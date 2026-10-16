import { PROVIDERS } from "./config.ts";
import type { Config } from "./config.ts";
import { createMessageAccumulator, parseSse, StreamErrorEvent, StreamProtocolError } from "./sse.ts";
import type { MessageResponse, ModelFn, ModelRequest } from "./types.ts";

export type ClientConfig = Pick<
  Config,
  "provider" | "apiKey" | "baseUrl" | "model" | "maxTokens" | "timeoutMs" | "maxRetries" | "stream"
> &
  Partial<Pick<Config, "showThinking">>;

export interface ClientHooks {
  onRequest?: (body: unknown) => void; // request body only, never headers
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
  onTextDelta?: (text: string) => void; // streaming only: text as it arrives
  onThinkingDelta?: (text: string) => void; // streaming only: readable thinking as it arrives
}

export interface ClientDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE_STATUS = new Set([429, 500, 529]);
const RETRYABLE_STREAM_ERRORS = new Set(["overloaded_error", "api_error", "rate_limit_error"]);
const BASE_DELAY_MS = 500;

/** Thrown when the request's signal is aborted (the user interrupted). Never retried. */
export class InterruptedError extends Error {
  constructor() {
    super("interrupted by the user");
    this.name = "InterruptedError";
  }
}

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
  const { label, keyVar } = PROVIDERS[config.provider];

  // Belt and braces: no error message leaves this module containing the key.
  // Also masks provider-masked fragments such as DeepSeek's "Your api key: ****abcd".
  const redact = (s: string) => s.split(config.apiKey).join("[redacted]").replace(/\*{3,}[\w-]{1,8}/g, "[redacted]");

  // `shown` tracks whether any text reached onTextDelta during this call. Once it has,
  // a retry would print the answer twice, so failures after that point are fatal.
  async function attempt(payload: string, shown: { value: boolean }, interrupt?: AbortSignal): Promise<Attempt> {
    // Idle timeout: aborts when nothing arrives for timeoutMs. For a non-streaming request
    // this is the whole request; for a stream it is the longest allowed gap between chunks.
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => controller.abort(new DOMException(`no data for ${config.timeoutMs} ms`, "TimeoutError")),
        config.timeoutMs,
      );
    };

    try {
      touch();
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: {
            "x-api-key": config.apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: payload,
          signal: interrupt ? AbortSignal.any([controller.signal, interrupt]) : controller.signal,
        });
      } catch (err) {
        return { kind: "retry", reason: describeNetworkError(err, config.timeoutMs) };
      }

      if (!res.ok) {
        let text = "";
        try {
          text = await res.text();
        } catch {
          // the status alone is enough to act on
        }
        const detail = `HTTP ${res.status}${errorDetail(text)}`;
        if (RETRYABLE_STATUS.has(res.status)) {
          return { kind: "retry", reason: detail, retryAfterMs: parseRetryAfter(res.headers.get("retry-after")) };
        }
        const hint = res.status === 401 ? ` (check ${keyVar})` : "";
        throw new Error(`${label} API error: ${detail}${hint}`);
      }

      if (!config.stream) {
        let text: string;
        try {
          text = await res.text();
        } catch (err) {
          return { kind: "retry", reason: describeNetworkError(err, config.timeoutMs) };
        }
        return { kind: "ok", response: parseResponse(text, label) };
      }

      return await readStream(res, touch, shown, interrupt);
    } finally {
      clearTimeout(timer);
    }
  }

  async function readStream(
    res: Response,
    touch: () => void,
    shown: { value: boolean },
    interrupt?: AbortSignal,
  ): Promise<Attempt> {
    if (!res.body) return { kind: "retry", reason: "stream response had no body" };
    const acc = createMessageAccumulator();
    const failed = (reason: string): Attempt => {
      if (shown.value) throw new Error(`${label} API stream failed after output began: ${reason}`);
      return { kind: "retry", reason };
    };

    try {
      for await (const sse of parseSse(res.body, touch)) {
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(sse.data);
        } catch {
          throw new StreamProtocolError(`stream sent invalid JSON: ${sse.data.slice(0, 300)}`);
        }
        const out = acc.apply(ev);
        if (out?.kind === "text") {
          shown.value = true;
          hooks.onTextDelta?.(out.text);
        } else if (out?.kind === "thinking" && config.showThinking && hooks.onThinkingDelta) {
          shown.value = true; // printed thinking would be printed twice by a retry, just like text
          hooks.onThinkingDelta(out.text);
        }
      }
    } catch (err) {
      if (interrupt?.aborted) throw new InterruptedError();
      if (err instanceof StreamErrorEvent) {
        if (RETRYABLE_STREAM_ERRORS.has(err.errorType)) return failed(`stream error ${err.message}`);
        throw new Error(`${label} API error in stream: ${err.message}`);
      }
      if (err instanceof StreamProtocolError) throw new Error(`${label} API stream error: ${err.message}`);
      return failed(describeNetworkError(err, config.timeoutMs));
    }

    try {
      return { kind: "ok", response: acc.finish() };
    } catch (err) {
      return failed(err instanceof Error ? err.message : String(err));
    }
  }

  return async function callModel(req: ModelRequest): Promise<MessageResponse> {
    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: config.maxTokens,
      system: req.system,
      messages: req.messages,
    };
    if (req.tools.length > 0) body.tools = req.tools;
    // Claude 5 models think by default but return the thinking empty unless asked for a summary.
    // This changes only what comes back, not how much the model thinks or what it costs.
    if (config.showThinking && returnsThinkingOnRequest(config.provider, config.model)) {
      body.thinking = { type: "adaptive", display: "summarized" };
    }
    if (config.stream) body.stream = true;
    hooks.onRequest?.(body);
    const payload = JSON.stringify(body);
    const shown = { value: false };

    const interrupt = req.signal;
    for (let n = 0; ; n++) {
      if (interrupt?.aborted) throw new InterruptedError();
      let result: Attempt;
      try {
        result = await attempt(payload, shown, interrupt);
      } catch (err) {
        if (interrupt?.aborted) throw new InterruptedError();
        throw new Error(redact(err instanceof Error ? err.message : String(err)));
      }
      // An aborted fetch looks like a network error; don't retry it.
      if (interrupt?.aborted) throw new InterruptedError();
      if (result.kind === "ok") return result.response;

      if (n >= config.maxRetries) {
        throw new Error(redact(`${label} API request failed after ${n + 1} attempt(s): ${result.reason}`));
      }
      const delayMs = result.retryAfterMs ?? backoff(n);
      hooks.onRetry?.({ attempt: n + 1, delayMs, reason: redact(result.reason) });
      // A retry-after can be long, so an interrupt ends the wait too.
      await Promise.race([sleep(delayMs), aborted(interrupt)]);
    }
  };
}

/**
 * The model's context window (max input tokens) from the provider's models API, or undefined if
 * it can't be found. Only Anthropic serves one. Never throws, and never retries: the meter can
 * do without it.
 */
export async function fetchContextWindow(
  config: Pick<Config, "provider" | "apiKey" | "baseUrl" | "model">,
  deps: { fetch?: typeof fetch } = {},
): Promise<number | undefined> {
  if (config.provider !== "anthropic") return undefined;
  try {
    const res = await (deps.fetch ?? fetch)(`${config.baseUrl}/v1/models/${encodeURIComponent(config.model)}`, {
      headers: { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { max_input_tokens?: unknown };
    const n = body.max_input_tokens;
    return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True for models whose thinking is hidden unless requested: Claude 5-family models, which think
 * by default with display "omitted". Older Claude models don't think unless thinking is turned on,
 * which would change cost and behaviour, so they're left alone. DeepSeek returns thinking already.
 */
export function returnsThinkingOnRequest(provider: Config["provider"], model: string): boolean {
  return provider === "anthropic" && /^claude-[a-z]+-5(?:-|$)/.test(model);
}

// Resolves when `signal` aborts; never resolves without one.
function aborted(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!signal) return;
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
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
    if (err.name === "TimeoutError" || err.name === "AbortError") return `timed out (no data for ${timeoutMs} ms)`;
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

function parseResponse(text: string, label: string): MessageResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} API returned invalid JSON: ${text.slice(0, 300)}`);
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { content?: unknown }).content)) {
    throw new Error(`${label} API response has no content array: ${text.slice(0, 300)}`);
  }
  return parsed as MessageResponse;
}
