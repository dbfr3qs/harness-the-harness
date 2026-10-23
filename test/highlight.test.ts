import { test } from "node:test";
import assert from "node:assert/strict";
import { highlightCodeLine } from "../src/highlight.ts";
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("characters are never altered (lossless)", () => {
  for (const [line, lang] of [["const x = 42; // hi", "js"], ["echo \"hi\" # c", "bash"], ["weird ~!@#$ stuff", undefined]] as const) {
    assert.equal(strip(highlightCodeLine(line, lang)), line);
  }
});
test("plain line with no tokens is just base code color", () => {
  assert.equal(highlightCodeLine("plain text", "text"), "\x1b[33mplain text\x1b[0m");
});
test("a string literal is colored green and line still ends reset", () => {
  const out = highlightCodeLine('x = "hi"', "python");
  assert.match(out, /\x1b\[32m"hi"/);
  assert.ok(out.endsWith("\x1b[0m"));
});
test("a comment is dimmed", () => {
  assert.match(highlightCodeLine("x = 1 # note", "python"), /\x1b\[2m# note/);
});
test("a keyword is colored", () => {
  assert.match(highlightCodeLine("if x:", "python"), /\x1b\[35mif\x1b/);
});
test("base color is re-asserted after a token", () => {
  assert.equal(highlightCodeLine("a 1 b", "js"), "\x1b[33ma \x1b[35m1\x1b[0m\x1b[33m b\x1b[0m");
});
test("lossless for odd inputs in every branch", () => {
  const lines = ['"unterminated', "'a\\'b' + \"c\\\"", "$ ls -la --color | grep 'x' && echo $HOME # hi", "", "   ", "a#b 1.5e3 x1 0x1F //", "\t# only comment", "https://x.y/z"];
  for (const lang of [undefined, "sh", "zsh", "ts", "python", "unknown"]) {
    for (const l of lines) assert.equal(strip(highlightCodeLine(l, lang)), l);
  }
});
test("shell flags and commands are colored; identifiers with digits are not numbers", () => {
  assert.match(highlightCodeLine("ls -la", "sh"), /\x1b\[35m-la\x1b/);
  assert.equal(highlightCodeLine("x1", "js"), "\x1b[33mx1\x1b[0m");
});
