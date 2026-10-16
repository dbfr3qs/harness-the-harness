import type { MessageResponse } from "./types.ts";

/**
 * Tokens the conversation occupies after a response: everything the model read (fresh and
 * cached input) plus what it wrote, which becomes input for the next request.
 */
export function contextAfter(res: MessageResponse): number {
  const u = res.usage;
  return (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0) + (u?.output_tokens ?? 0);
}

/** 1234 -> "1.2k", 1000000 -> "1M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${trim(n / 1000)}k`;
  return `${trim(n / 1_000_000)}M`;
}

function trim(x: number): string {
  return (x >= 100 ? x.toFixed(0) : x.toFixed(1)).replace(/\.0$/, "");
}

export interface ContextReading {
  used: number;
  window: number | undefined; // undefined when the model's context window isn't known
  stale?: string; // why the reading may be off, e.g. measured before a provider switch
}

export const WARN_AT = 0.8; // from here, the meter suggests /reset

/** "context 23.4k/1M (2%)" for the line after each answer. */
export function contextSummary(r: ContextReading): string {
  const approx = r.stale ? "≈" : "";
  if (!r.window) return `context ${approx}${formatTokens(r.used)}`;
  return `context ${approx}${formatTokens(r.used)}/${formatTokens(r.window)} (${percent(r.used / r.window)})`;
}

function percent(f: number): string {
  const p = f * 100;
  return p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`;
}

/** A bar of `width` cells: "████░░░░░░". */
export function contextBar(fraction: number, width = 30): string {
  const filled = Math.min(width, Math.max(0, Math.round(fraction * width)));
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

/** The /context report. */
export function describeContext(r: ContextReading, model: string, messages: number): string {
  if (messages === 0) {
    return `Context: empty (no conversation yet). Window for ${model}: ${r.window ? `${r.window.toLocaleString("en-US")} tokens` : "unknown"}.`;
  }
  const lines: string[] = [];
  if (r.window) {
    const f = r.used / r.window;
    lines.push(
      `Context: ${r.used.toLocaleString("en-US")} of ${r.window.toLocaleString("en-US")} tokens (${percent(f)}) · ${model} · ${messages} message(s)`,
      `  ${contextBar(f)}  ${formatTokens(Math.max(0, r.window - r.used))} left`,
    );
    if (f >= WARN_AT) lines.push(fullWarning(f));
  } else {
    lines.push(
      `Context: ${r.used.toLocaleString("en-US")} tokens · ${model} · ${messages} message(s)`,
      "  The context window for this model isn't known; set CONTEXT_WINDOW to show how full it is.",
    );
  }
  lines.push(r.stale ? `  Approximate: ${r.stale}.` : "  Measured after the last response; your next message and any tool results add to it.");
  return lines.join("\n");
}

export function fullWarning(fraction: number): string {
  return `[context ${percent(fraction)} full: older messages are never dropped automatically, so the request will fail when it's full. /reset starts a fresh conversation]`;
}
