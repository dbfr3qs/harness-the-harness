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
test("bold and italic are styled, markers removed", () => {
  assert.equal(render("a **b** c *d* e"), "a \x1b[1mb\x1b[0m c \x1b[3md\x1b[0m e");
  assert.equal(render("__x__ _y_"), "\x1b[1mx\x1b[0m \x1b[3my\x1b[0m");
});
test("a standalone asterisk stays literal", () => {
  assert.equal(render("2 * 3 = 6"), "2 * 3 = 6");
});
test("a link shows styled text then a dim URL", () => {
  assert.equal(render("see [docs](http://x)"), "see \x1b[4mdocs\x1b[0m \x1b[2m(http://x)\x1b[0m");
});
test("unterminated emphasis flushes literally", () => {
  assert.equal(render("**oops"), "**oops");
  assert.equal(render("[text"), "[text");
});
test("chunk-split invariance over emphasis and links", () => {
  assertChunkInvariant("x **b** y [t](http://z) *i* `c`");
});
test("unclosed emphasis/link markers never stall or leak past a newline", () => {
  for (const md of ["a **b\nc", "a *b\nc *d", "a _b\nc", "a [b\nc](u)", "a [b](u\nc)"]) {
    assert.equal(render(md), md);
    assertChunkInvariant(md);
  }
  const s = createMarkdownStream();
  assert.equal(s.write("a **b\nc"), "a **b\nc");
  assert.equal(s.write("x [y\nz"), "x [y\nz");
});
test("snake_case underscores stay literal; inline code nests in bold", () => {
  assert.equal(render("snake_case_name"), "snake_case_name");
  assert.equal(render("**a `c` b**"), "\x1b[1ma \x1b[33mc\x1b[0m\x1b[1m b\x1b[0m");
  assertChunkInvariant("snake_case **a `c` b** _x_ [**t**](u)");
});
