import { test } from "node:test";
import assert from "node:assert/strict";
import { createMarkdownSink, createMarkdownStream, renderMarkdown } from "../src/markdown.ts";

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

test("ATX heading is cyan-bold with markers stripped", () => {
  assert.equal(render("# Hello"), "\x1b[1;36mHello\x1b[0m");
  assert.equal(render("## Two ##"), "\x1b[1;36mTwo\x1b[0m");
});
test("a heading gets one blank line before and after", () => {
  assert.equal(render("intro\n# H\nbody"), "intro\n\n\x1b[1;36mH\x1b[0m\n\nbody");
});
test("unordered list items get a bullet; inline still applies", () => {
  assert.equal(render("- one\n- a **b**"), "• one\n• a \x1b[1mb\x1b[0m");
});
test("ordered list keeps its number", () => {
  assert.equal(render("1. first\n2. second"), "1. first\n2. second");
});
test("blockquote gets a dim bar", () => {
  assert.equal(render("> quoted"), "\x1b[2m│ \x1b[0mquoted");
});
test("thematic break becomes a dim rule", () => {
  assert.equal(render("a\n---\nb"), "a\n\n\x1b[2m" + "─".repeat(32) + "\x1b[0m\n\nb");
});
test("runs of blank lines collapse to one", () => {
  assert.equal(render("a\n\n\n\nb"), "a\n\nb");
});
test("chunk-split invariance over mixed block content", () => {
  assertChunkInvariant("# Title\n\nsome *text*\n\n- a\n- b\n\n> q\n\n---\n\nend");
});
test("block-marker lookalikes stay literal and chunk-invariant", () => {
  for (const md of ["#hash", "####### seven", "-x", "--", "**bold** text", "1.x", "12", "+ p\n  - n", "***b***", "> "]) {
    assertChunkInvariant(md);
  }
  assert.equal(render("#hash"), "#hash");
  assert.equal(render("-x"), "-x");
  assert.equal(render("+ p\n  - n"), "• p\n  • n");
});
test("heading text is inline-rendered", () => {
  assert.equal(render("# a **b**"), "\x1b[1;36ma \x1b[1mb\x1b[0m");
  assert.equal(render("# a **b** c"), "\x1b[1;36ma \x1b[1mb\x1b[0m\x1b[1;36m c\x1b[0m");
  assert.equal(render("# use `x`"), "\x1b[1;36muse \x1b[33mx\x1b[0m");
  assert.ok(!render("# use `x`").includes("`"));
  assertChunkInvariant("# a **b** c");
});
test("an empty heading emits no empty styled span", () => {
  assert.equal(render("# "), "");
  assert.equal(render("a\n# \nb"), "a\n\nb");
});

test("fenced code is colored verbatim; fences removed; markup not parsed", () => {
  assert.equal(render("```\nx = 1\n# not a heading\n```"),
    "\x1b[33mx = 1\x1b[0m\n\x1b[33m# not a heading\x1b[0m");
});
test("a fenced block gets one blank line before and after", () => {
  assert.equal(render("before\n```\ncode\n```\nafter"),
    "before\n\n\x1b[33mcode\x1b[0m\n\nafter");
});
test("an unclosed fence flushes its content as code", () => {
  assert.equal(render("```\nabc\ndef"), "\x1b[33mabc\x1b[0m\n\x1b[33mdef\x1b[0m");
});
test("a 4-space indented line is code (first 4 spaces stripped)", () => {
  assert.equal(render("text\n\n    code()\n\nmore"),
    "text\n\n\x1b[33mcode()\x1b[0m\n\nmore");
});
test("chunk-split invariance over a fenced block", () => {
  assertChunkInvariant("text\n```js\nconst a = `t`;\n```\nmore");
});
test("fenced code keeps ** - and backticks literal", () => {
  assert.equal(render("~~~\n**b** - x `y`\n~~~"), "\x1b[33m**b** - x `y`\x1b[0m");
});

test("chunk-split invariance: unclosed fence, indented code, blank line in fence", () => {
  assertChunkInvariant("```\nabc\ndef");
  assertChunkInvariant("text\n\n    code()\n    more()\n\nafter");
  assertChunkInvariant("```\na\n\nb\n```\nz");
  assertChunkInvariant("- step\n    ```bash\n    cmd\n    ```\nz");
  assertChunkInvariant("- item\n    more\n\nnext");
});
test("a blank line inside a fence is kept", () => {
  assert.equal(render("```\na\n\nb\n```"), "\x1b[33ma\x1b[0m\n\n\x1b[33mb\x1b[0m");
});
test("a closing fence longer than the opener still closes", () => {
  assert.equal(render("```\na\n`````\nz"), "\x1b[33ma\x1b[0m\n\nz");
});
test("a ~~~ line inside a ``` block stays content", () => {
  assert.equal(render("```\na\n~~~\nb\n```"), "\x1b[33ma\x1b[0m\n\x1b[33m~~~\x1b[0m\n\x1b[33mb\x1b[0m");
});
test("an indented fence under a list item opens a real fenced block", () => {
  assert.equal(render("- step\n    ```bash\n    cmd\n    ```"), "• step\n\n\x1b[33m\x1b[35mcmd\x1b[0m"); // bash: command word highlighted
});
test("indented text under a list item is a continuation, not code", () => {
  assert.equal(render("- item\n    more"), "• item\nmore");
});
test("list context ends at a top-level line; indented code then works", () => {
  assert.equal(render("- item\n\npara\n\n    code()"), "• item\n\npara\n\n\x1b[33mcode()\x1b[0m");
});

test("renderMarkdown is a one-shot render", () => {
  assert.equal(renderMarkdown("**hi**"), "\x1b[1mhi\x1b[0m");
});
test("an enabled sink routes deltas through the renderer", () => {
  let out = "";
  const sink = createMarkdownSink((s) => { out += s; }, true);
  sink.text("**h"); sink.text("i**"); sink.flush();
  assert.equal(out, "\x1b[1mhi\x1b[0m");
});
test("a disabled sink passes deltas through raw", () => {
  let out = "";
  const sink = createMarkdownSink((s) => { out += s; }, false);
  sink.text("**hi**"); sink.flush();
  assert.equal(out, "**hi**");
});
test("flush resets the sink for the next run", () => {
  let out = "";
  const sink = createMarkdownSink((s) => { out += s; }, true);
  sink.text("`a"); sink.flush();      // unterminated → literal
  out = "";
  sink.text("`b`"); sink.flush();      // fresh state
  assert.equal(out, "\x1b[33mb\x1b[0m");
});
test("triple markers collapse to bold+italic with no stray markers", () => {
  assert.equal(render("***x***"), "\x1b[1;3mx\x1b[0m");
  assert.equal(render("___x___"), "\x1b[1;3mx\x1b[0m");
  assert.equal(render("a ***b `c` d*** e"), "a \x1b[1;3mb \x1b[33mc\x1b[0m\x1b[1;3m d\x1b[0m e");
  assert.equal(render("**b** *i*"), "\x1b[1mb\x1b[0m \x1b[3mi\x1b[0m");
});
test("unterminated triple marker is literal, never stalls or leaks", () => {
  assert.equal(render("***oops"), "***oops");
  assert.equal(render("***oops\nnext"), "***oops\nnext");
  const s = createMarkdownStream();
  assert.equal(s.write("***a\nb"), "***a\nb");
});
test("chunk-split invariance over triple markers", () => {
  assertChunkInvariant("a ***b*** c");
  assertChunkInvariant("a ___b___ c ***d\ne*** f");
});

test("fenced code is syntax-highlighted by its info string", () => {
  const out = render("```python\nx = \"hi\" # c\n```");
  assert.match(out, /\x1b\[32m"hi"/);
  assert.match(out, /\x1b\[2m# c/);
  assert.ok(out.replace(/\x1b\[[0-9;]*m/g, "").includes('x = "hi" # c'));
});
test("fenced code with no/unknown info string stays plain yellow", () => {
  assert.equal(render("```\nplain\n```"), "\x1b[33mplain\x1b[0m");
});
test("highlighted fenced block is still chunk-invariant", () => {
  assertChunkInvariant("text\n```js\nconst a = 1; // x\n```\nmore");
});

test("unrecognized fence languages stay plain yellow", () => {
  for (const l of ["text", "output", "console", "foo"])
    assert.equal(render("```" + l + "\n12 # a\n```"), "\x1b[33m12 # a\x1b[0m", l);
});
test("recognized fence language still highlights", () => {
  assert.match(render('```python\nx = "hi"\n```'), /\x1b\[32m"hi"/);
});

const renderDim = (md: string) => { const s = createMarkdownStream({ dim: true }); return s.write(md) + s.flush(); };
test("dim mode styles everything dim, no palette colors, markers gone", () => {
  const out = renderDim("# H\n\n**b** `c`");
  assert.ok(!out.includes("\x1b[1;36m") && !out.includes("\x1b[33m")); // no heading cyan / code yellow
  assert.match(out, /\x1b\[2m/);                                       // dim present
  const stripped = out.replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(!stripped.includes("#") && !stripped.includes("**") && !stripped.includes("`")); // markers removed
});
test("dim mode still ends reset and is chunk-invariant", () => {
  const whole = renderDim("a **b** c");
  assert.equal(whole.match(/\x1b\[[0-9;]*m/g)!.at(-1), "\x1b[0m"); // last style is a reset (text may follow it)
  for (let i = 0; i <= "a **b** c".length; i++) {
    const s = createMarkdownStream({ dim: true });
    assert.equal(s.write("a **b** c".slice(0, i)) + s.write("a **b** c".slice(i)) + s.flush(), whole);
  }
});
test("dim mode does not syntax-highlight fenced code", () => {
  const out = renderDim("```js\nconst x = 1;\n```");
  assert.ok(!/\x1b\[(?!0m|2m)[0-9;]*m/.test(out));
  assert.ok(out.includes("const x = 1;"));
});

const unDimmed = (out: string) => out.replace(/\x1b\[2m[^\x1b]*?\x1b\[0m/g, "").replace(/\n/g, "");
test("dim mode dims plain prose", () => {
  const out = renderDim("plain words");
  assert.ok(out.startsWith("\x1b[2m") && out.endsWith("\x1b[0m"));
  assert.equal(unDimmed(out), "");
});
test("dim mode keeps text after a span dim", () => {
  const out = renderDim("a **b** c");
  assert.equal(unDimmed(out), "");
  assert.ok(out.endsWith("\x1b[0m"));
});
test("dim mode dims mixed blocks and keeps separators clean", () => {
  const out = renderDim("# H\n\npara\n\n- item");
  assert.equal(unDimmed(out), "");
  assert.ok(out.endsWith("\x1b[0m"));
  assert.ok(!/\x1b\[2m\n/.test(out));
  assert.ok(out.includes("\x1b[2mpara\x1b[0m") && out.includes("item"));
});
