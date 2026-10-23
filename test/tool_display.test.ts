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
test("escape sequences and control bytes are stripped from the preview", () => {
  const out = formatToolResult("\x1b[2Jhi\x07\n\x1b]0;title\x07there\x00\x08!");
  const plain = out.map(strip);
  assert.equal(plain[0], "    hi");
  assert.equal(plain[1], "    there!");
  assert.ok(!/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/.test(plain.join("\n")));
  assert.ok(!plain.join("\n").includes("\x1b"));
});
test("both caps: bounded content and correct marker", () => {
  const big = ("y".repeat(5000) + "\n").repeat(3);
  const out = formatToolResult(big, { maxLines: 3, maxChars: 800 });
  const plain = out.map(strip);
  const content = plain.filter((l) => !l.includes("…")).join("\n");
  assert.ok(content.length <= 800 + 4 * 3);
  assert.match(plain.at(-1)!, /truncated/);
  const more = formatToolResult(("z\n").repeat(20), { maxLines: 3, maxChars: 800 }).map(strip);
  assert.equal(more.at(-1), "    … +17 more lines");
});

test("empty error result still shows the failure marker", () => {
  const out = formatToolResult("   ", { error: true });
  assert.equal(out.length, 1);
  assert.ok(/^\s*✗/.test(out[0]!.replace(/\x1b\[[0-9;]*m/g, "")));
});

test("C1 control bytes are stripped", () => {
  const out = formatToolResult("a\x9b31mb").join("");
  assert.ok(!out.includes("\x9b"));
});

test("char cap does not split a surrogate pair", () => {
  const cap = 20;
  const out = formatToolResult("x".repeat(cap - 1) + "😀rest", { maxChars: cap });
  const line = out[0]!.replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(!/[\uD800-\uDBFF]$/.test(line));
});
