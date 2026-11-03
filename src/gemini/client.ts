import { randomUUID } from "node:crypto";
import { PROVIDERS } from "../config.ts";
import { aborted, backoff, describeNetworkError, InterruptedError, parseRetryAfter } from "../client.ts";
import type { ClientConfig, ClientDeps, ClientHooks } from "../client.ts";
import { parseSse } from "../sse.ts";
import type { MessageResponse, ModelFn, ModelRequest } from "../types.ts";
import { buildGeminiRequest, createGeminiStreamAccumulator, parseGeminiResponse } from "./translate.ts";
import type { GeminiResponse } from "./translate.ts";

type Attempt =
  | { kind: "ok"; response: MessageResponse }
  | { kind: "retry"; reason: string; retryAfterMs?: number };

// A stream problem a retry won't fix.
class FatalStreamError extends Error {}

const retryableStatus = (n: number) => n === 429 || n >= 500;

// Formats " STATUS: message" from a Gemini error body ({error:{code,status,message}}), or a raw snippet.
function errorDetail(text: string): string {
  try {
    const e = (JSON.parse(text) as { error?: { status?: unknown; message?: unknown } })?.error;
    if (e && (typeof e.status === "string" || typeof e.message === "string")) {
      return ` ${String(e.status ?? "UNKNOWN")}: ${String(e.message ?? "")}`;
    }
  } catch {
    // fall through to raw snippet
  }
  const snippet = text.trim().slice(0, 300);
  return snippet ? ` ${snippet}` : "";
}

export function createGeminiClient(config: ClientConfig, hooks: ClientHooks = {}, deps: ClientDeps = {}): ModelFn {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => performance.now());
  const method = config.stream ? "streamGenerateContent?alt=sse" : "generateContent";
  const url = `${config.baseUrl}/v1beta/models/${encodeURIComponent(config.model)}:${method}`;
  const { label, keyVar } = PROVIDERS[config.provider];

  const redact = (s: string) => s.split(config.apiKey).join("[redacted]");

  async function attempt(payload: string, shown: { value: boolean }, interrupt?: AbortSignal): Promise<Attempt> {
    // Idle timeout, as in the Anthropic client.
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
      const t0 = now();
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: { "x-goog-api-key": config.apiKey, "Content-Type": "application/json" },
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
        if (retryableStatus(res.status)) {
          return { kind: "retry", reason: detail, retryAfterMs: parseRetryAfter(res.headers.get("retry-after")) };
        }
        const hint = res.status === 401 || res.status === 403 || /api key/i.test(text) ? ` (check ${keyVar})` : "";
        throw new Error(`${label} API error: ${detail}${hint}`);
      }

      if (!config.stream) {
        let text: string;
        try {
          text = await res.text();
        } catch (err) {
          return { kind: "retry", reason: describeNetworkError(err, config.timeoutMs) };
        }
        let parsed: GeminiResponse;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new Error(`${label} API returned invalid JSON: ${text.slice(0, 300)}`);
        }
        return { kind: "ok", response: parseGeminiResponse(parsed, config.model, `gemini_${randomUUID()}`) };
      }

      return await readStream(res, touch, shown, t0, interrupt);
    } finally {
      clearTimeout(timer);
    }
  }

  async function readStream(
    res: Response,
    touch: () => void,
    shown: { value: boolean },
    t0: number,
    interrupt?: AbortSignal,
  ): Promise<Attempt> {
    if (!res.body) return { kind: "retry", reason: "stream response had no body" };
    const acc = createGeminiStreamAccumulator(config.model, `gemini_${randomUUID()}`);
    const timing = Boolean(hooks.onFirstToken || hooks.onStreamDone);
    let inputTokens = 0;
    let firstAt: number | undefined;
    const failed = (reason: string): Attempt => {
      if (shown.value) throw new FatalStreamError(`${label} API stream failed after output began: ${reason}`);
      return { kind: "retry", reason };
    };

    try {
      for await (const sse of parseSse(res.body, touch)) {
        let ev: GeminiResponse & { error?: { code?: unknown; status?: unknown; message?: unknown } };
        try {
          ev = JSON.parse(sse.data);
        } catch {
          throw new FatalStreamError(`${label} API stream error: stream sent invalid JSON: ${sse.data.slice(0, 300)}`);
        }
        if (ev.error) {
          const code = Number(ev.error.code);
          const msg = `${String(ev.error.status ?? "UNKNOWN")}: ${String(ev.error.message ?? "")}`;
          if (retryableStatus(code)) return failed(`stream error ${msg}`);
          throw new FatalStreamError(`${label} API error in stream: ${msg}`);
        }
        if (timing && ev.usageMetadata?.promptTokenCount !== undefined) inputTokens = ev.usageMetadata.promptTokenCount;
        const out = acc.push(ev);
        const thinking = config.showThinking && hooks.onThinkingDelta ? out.thinkingDelta : undefined;
        if (timing && firstAt === undefined && (out.textDelta || out.thinkingDelta)) {
          firstAt = now();
          hooks.onFirstToken?.({ inputTokens, ttftMs: firstAt - t0 });
        }
        if (thinking) {
          shown.value = true; // printed thinking would be printed twice by a retry, just like text
          hooks.onThinkingDelta?.(thinking);
        }
        if (out.textDelta) {
          shown.value = true;
          hooks.onTextDelta?.(out.textDelta);
        }
      }
    } catch (err) {
      if (interrupt?.aborted) throw new InterruptedError();
      if (err instanceof FatalStreamError) throw new Error(err.message);
      return failed(describeNetworkError(err, config.timeoutMs));
    }

    const response = acc.finish();
    if (firstAt !== undefined && hooks.onStreamDone) {
      hooks.onStreamDone({ outputTokens: response.usage.output_tokens, decodeMs: now() - firstAt });
    }
    return { kind: "ok", response };
  }

  return async function callModel(req: ModelRequest): Promise<MessageResponse> {
    // Always ask for thoughts (display is gated by showThinking), so signatures come back.
    const { body } = buildGeminiRequest(req, config.maxTokens, true);
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
      if (interrupt?.aborted) throw new InterruptedError();
      if (result.kind === "ok") return result.response;

      if (n >= config.maxRetries) {
        throw new Error(redact(`${label} API request failed after ${n + 1} attempt(s): ${result.reason}`));
      }
      const delayMs = result.retryAfterMs ?? backoff(n);
      hooks.onRetry?.({ attempt: n + 1, delayMs, reason: redact(result.reason) });
      await Promise.race([sleep(delayMs), aborted(interrupt)]);
    }
  };
}
