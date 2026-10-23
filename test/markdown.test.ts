import { test } from "node:test";
import assert from "node:assert/strict";
import { createMarkdownStream } from "../src/markdown.ts";

const render = (md: string): string => {
  const s = createMarkdownStream();
  return s.write(md) + s.flush();
};
// Feeding the same text split at every boundary must match render(md).
const assertChunkInvariant = (md: string): void => {
  const whole = render(md);
  for (let i = 0; i <= md.length; i++) {
    const s = createMarkdownStream();
    assert.equal(s.write(md.slice(0, i)) + s.write(md.slice(i)) + s.flush(), whole, `split at ${i}`);
  }
};

test("plain text passes through and flushes clean", () => {
  assert.equal(render("hello world"), "hello world");
});
test("inline code is colored and backticks removed", () => {
  assert.equal(render("use `x = 1` now"), "use \x1b[33mx = 1\x1b[0m now");
});
test("inline code content is verbatim (no inner parsing)", () => {
  assert.equal(render("`**not bold**`"), "\x1b[33m**not bold**\x1b[0m");
});
test("an unmatched backtick stays literal", () => {
  assert.equal(render("a ` b"), "a ` b");
});
test("the ambiguous tail is held until the span closes", () => {
  const s = createMarkdownStream();
  const a = s.write("value ");
  const b = s.write("`code");
  const c = s.write("` done") + s.flush();
  assert.equal(b, ""); // nothing emitted while the code span is open
  assert.equal(a + b + c, "value \x1b[33mcode\x1b[0m done");
});
test("every emitted styled span is reset (no ANSI leak)", () => {
  assert.ok(render("`x`").endsWith("\x1b[0m"));
});
test("a backtick with no closer on its line is literal (no stall, no leak)", () => {
  assert.equal(render("a `b\nc"), "a `b\nc");
  assert.ok(!render("a `b\nc").includes("\x1b[33m"));
  assert.equal(render("a `b\nc` d"), "a `b\nc` d");
  assertChunkInvariant("a `b\nc` d");
  const s = createMarkdownStream();
  assert.equal(s.write("a `b\nc"), "a `b\nc"); // no stall past end of line
});
test("chunk-split invariance over text and code spans", () => {
  assertChunkInvariant("a `b c` d `e` f");
});
