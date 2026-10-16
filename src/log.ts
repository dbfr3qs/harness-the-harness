import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type LogKind = "request" | "response" | "tool_call" | "tool_result" | "error" | "session";

export interface TranscriptLogger {
  path: string;
  log(kind: LogKind, data: unknown): void;
  flush(): Promise<void>; // resolves once every queued line has been written (or failed)
}

/**
 * Appends one `{ ts, kind, data }` JSON object per line. Writes are queued so lines keep their
 * order. Failures print a warning and never throw: logging must not stop the conversation.
 * Any `secrets` are scrubbed from each line as a last line of defence; callers should still
 * never pass headers or keys in `data`.
 */
export function createTranscriptLogger(
  path: string,
  opts: { secrets?: string[]; warn?: (msg: string) => void } = {},
): TranscriptLogger {
  const secrets = (opts.secrets ?? []).filter((s) => s.length > 0);
  const warn = opts.warn ?? ((msg: string) => console.error(msg));
  let warned = false;
  const onError = (err: unknown) => {
    if (warned) return;
    warned = true;
    const reason = err instanceof Error ? err.message : String(err);
    warn(`[warning: transcript logging to ${path} failed: ${reason}; further warnings suppressed]`);
  };

  let queue: Promise<void> = mkdir(dirname(path), { recursive: true }).then(() => {}, onError);

  function log(kind: LogKind, data: unknown): void {
    let line: string;
    try {
      line = JSON.stringify({ ts: new Date().toISOString(), kind, data });
    } catch (err) {
      onError(err);
      return;
    }
    for (const secret of secrets) line = line.split(secret).join("[redacted]");
    queue = queue.then(() => appendFile(path, `${line}\n`, "utf8")).catch(onError);
  }

  return { path, log, flush: () => queue };
}
