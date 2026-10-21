// Token-speed arithmetic and formatting for the status bar. Pure, so the REPL's live wiring
// (src/repl.ts) can stay untested while these carry the logic. See the token-speed design doc.

/** Tokens per second from a token count over a span in milliseconds; 0 when the span is non-positive. */
export function tokensPerSec(tokens: number, ms: number): number {
  return ms <= 0 ? 0 : tokens / (ms / 1000);
}

/** Renders a rate as "<n> tok/s", or "<n.n>k tok/s" for 1000 and above. */
function rate(tokPerSec: number): string {
  return tokPerSec >= 1000 ? `${(tokPerSec / 1000).toFixed(1)}k tok/s` : `${Math.round(tokPerSec)} tok/s`;
}

/** Status-bar fields for the available speeds. A missing or zero figure is omitted. */
export function formatSpeed(prefill: number | undefined, decode: number | undefined): string[] {
  const parts: string[] = [];
  if (prefill) parts.push(`prefill ${rate(prefill)}`);
  if (decode) parts.push(`decode ${rate(decode)}`);
  return parts;
}
