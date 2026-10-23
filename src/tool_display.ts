import { dimText } from "./terminal.ts";

const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

/** A tool-call line: cyan arrow + name, dimmed remainder of the description. */
export function toolCallLine(name: string, description: string): string {
  const rest = description.startsWith(name) ? description.slice(name.length) : ` ${description}`;
  return `  ${CYAN}→ ${name}${RESET}${rest ? dimText(rest) : ""}`;
}

export interface ToolResultOptions {
  maxLines?: number;
  maxChars?: number;
  error?: boolean;
}

/** A bounded, dimmed, indented preview of a tool result. Empty content yields no lines. */
export function formatToolResult(content: string, opts: ToolResultOptions = {}): string[] {
  const maxLines = opts.maxLines ?? 8;
  const maxChars = opts.maxChars ?? 800;
  // Tool output is untrusted: drop ANSI/OSC escapes and control bytes (keeping \n and \t) before bounding.
  content = content
    .replace(/\r\n?/g, "\n")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
  let text = content.replace(/\s+$/, "");
  if (!text.trim()) return opts.error ? [dimText("    ✗ (no output)")] : [];
  if (opts.error) text = `✗ ${text.replace(/^Error:\s*/, "")}`;

  let charTruncated = false;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    charTruncated = true;
  }
  const lines = text.split("\n");
  const shown = lines.slice(0, maxLines);
  const out = shown.map((l) => dimText(`    ${l}`));
  if (lines.length > maxLines) {
    // Line cap hit: count what remains of the full content's lines.
    const total = content.replace(/\s+$/, "").split("\n").length;
    out.push(dimText(`    … +${total - maxLines} more lines`));
  } else if (charTruncated) {
    out.push(dimText("    … (truncated)"));
  }
  return out;
}
