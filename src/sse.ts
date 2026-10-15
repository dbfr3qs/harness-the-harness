import type { MessageResponse } from "./types.ts";

/** One server-sent event. `data` is the raw payload; Anthropic sends JSON whose `type` repeats `event`. */
export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Splits a byte stream into server-sent events. `onChunk` fires for every chunk received,
 * which lets the caller reset an idle timeout.
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  onChunk: () => void = () => {},
): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  let data: string[] = [];

  function* drain(final: boolean): Generator<SseEvent> {
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1 || (final && buffer.length > 0)) {
      const end = newline === -1 ? buffer.length : newline;
      const line = buffer.slice(0, end).replace(/\r$/, "");
      buffer = buffer.slice(end + 1);
      if (line === "") {
        if (data.length > 0) yield { event: event || "message", data: data.join("\n") };
        event = "";
        data = [];
      } else if (!line.startsWith(":")) {
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
    }
  }

  for await (const chunk of body) {
    onChunk();
    buffer += decoder.decode(chunk, { stream: true });
    yield* drain(false);
  }
  buffer += decoder.decode();
  yield* drain(true);
  if (data.length > 0) yield { event: event || "message", data: data.join("\n") };
}

/** An `error` event sent inside a stream that had already returned HTTP 200. */
export class StreamErrorEvent extends Error {
  errorType: string;
  constructor(errorType: string, message: string) {
    super(`${errorType}: ${message}`);
    this.errorType = errorType;
  }
}

/**
 * The stream broke the protocol in a way a retry won't fix: an unknown delta type, invalid
 * JSON, or a delta for a block that never started. Rebuilding anyway would alter history.
 */
export class StreamProtocolError extends Error {}

type Block = { type: string; [key: string]: unknown };

/**
 * Rebuilds the message the non-streaming API would have returned from stream events.
 * `apply` returns the text of a `text_delta` so the caller can show it as it arrives.
 */
export function createMessageAccumulator() {
  let message: Record<string, unknown> | undefined;
  let content: Block[] = [];
  const partialJson = new Map<number, string>();
  let stopped = false;

  function blockAt(index: number): Block {
    const block = content[index];
    if (!block) throw new StreamProtocolError(`stream sent a delta for content block ${index} before it started`);
    return block;
  }

  function finishToolInput(index: number): void {
    const raw = partialJson.get(index);
    if (raw === undefined) return;
    partialJson.delete(index);
    const block = blockAt(index);
    if (raw.trim() === "") {
      block.input = {};
      return;
    }
    try {
      block.input = JSON.parse(raw);
    } catch {
      // Possible when output is cut off by max_tokens. dispatch turns this into an error result.
      block.input = { _invalidJson: raw };
    }
  }

  function apply(ev: Record<string, any>): string | undefined {
    switch (ev.type) {
      case "message_start":
        message = { ...ev.message };
        content = [];
        return undefined;
      case "content_block_start": {
        const block = structuredClone(ev.content_block) as Block;
        content[ev.index] = block;
        if (block.type === "tool_use" || block.type === "server_tool_use") partialJson.set(ev.index, "");
        return undefined;
      }
      case "content_block_delta": {
        const block = blockAt(ev.index);
        const delta = ev.delta ?? {};
        switch (delta.type) {
          case "text_delta":
            block.text = String(block.text ?? "") + delta.text;
            return block.type === "text" ? delta.text : undefined;
          case "input_json_delta":
            partialJson.set(ev.index, (partialJson.get(ev.index) ?? "") + delta.partial_json);
            return undefined;
          case "thinking_delta":
            block.thinking = String(block.thinking ?? "") + delta.thinking;
            return undefined;
          case "signature_delta":
            block.signature = delta.signature;
            return undefined;
          case "citations_delta":
            block.citations = [...((block.citations as unknown[]) ?? []), delta.citation];
            return undefined;
          default:
            throw new StreamProtocolError(
              `stream sent an unknown delta type "${delta.type}" for a "${block.type}" block; ` +
                "it cannot be rebuilt verbatim. Set STREAM=0 to use non-streaming requests.",
            );
        }
      }
      case "content_block_stop":
        finishToolInput(ev.index);
        return undefined;
      case "message_delta":
        if (!message) throw new StreamProtocolError("stream sent message_delta before message_start");
        Object.assign(message, ev.delta);
        if (ev.usage) message.usage = { ...(message.usage as object), ...ev.usage };
        return undefined;
      case "message_stop":
        stopped = true;
        return undefined;
      case "error":
        throw new StreamErrorEvent(String(ev.error?.type ?? "unknown_error"), String(ev.error?.message ?? ""));
      default:
        return undefined; // ping, and any new event types that don't change content
    }
  }

  function finish(): MessageResponse {
    if (!message || !stopped) throw new Error("stream ended before message_stop");
    for (const index of [...partialJson.keys()]) finishToolInput(index);
    return { ...message, content } as unknown as MessageResponse;
  }

  return { apply, finish };
}
