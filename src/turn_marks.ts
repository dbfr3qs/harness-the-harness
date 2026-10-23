/** A dim horizontal rule that separates one user-initiated turn from the previous output. */
export function turnRule(width: number): string {
  return `\x1b[2m${"─".repeat(Math.max(1, width))}\x1b[0m`;
}
