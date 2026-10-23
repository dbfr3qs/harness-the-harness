import { test } from "node:test";
import assert from "node:assert/strict";
import { toolCallLine, formatToolResult } from "../src/tool_display.ts";
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("call line colors the arrow and tool name, dims the args", () => {
  const line = toolCallLine("run_shell", "run_shell id");
  assert.equal(strip(line), "  → run_shell id");
  assert.match(line, /\x1b\[36m/); // cyan present
});
test("result preview is dimmed, indented, and bounded by lines", () => {
  const out = formatToolResult("a\nb\nc\nd\ne\nf\ng\nh\ni\nj", { maxLines: 3 });
  assert.equal(out.length, 4); // 3 lines + the truncation marker
  assert.equal(strip(out[0]!), "    a");
  assert.equal(strip(out[3]!), "    … +7 more lines");
});
test("result preview is bounded by chars", () => {
  const out = formatToolResult("x".repeat(5000), { maxChars: 100 });
  assert.ok(strip(out.join("\n")).length <= 140); // content + marker, well under 5000
  assert.match(strip(out.at(-1)!), /truncated/);
});
test("error result is marked", () => {
  const out = formatToolResult("boom", { error: true });
  assert.match(strip(out[0]!), /^    ✗ boom/);
});
test("empty content yields no preview", () => {
  assert.deepEqual(formatToolResult("   "), []);
});
