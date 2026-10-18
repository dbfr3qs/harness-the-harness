import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { charWidth, createScreen, fit, graphemes, textWidth } from "../src/screen.ts";

// A fake terminal: keystrokes go in through `type`, and everything drawn is collected.
function fakeTerminal(cols = 60, rows = 12) {
  const resizeHandlers: (() => void)[] = [];
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => input }) as unknown as NodeJS.ReadStream & PassThrough;
  let written = "";
  const output = Object.assign(
    new Writable({
      write(chunk, _enc, cb) {
        written += String(chunk);
        cb();
      },
    }),
    { columns: cols, rows, isTTY: true },
  ) as unknown as NodeJS.WriteStream;
  const realOn = output.on.bind(output);
  output.on = ((event: string, fn: () => void) => {
    if (event === "resize") resizeHandlers.push(fn);
    return realOn(event, fn);
  }) as typeof output.on;
  const screen = createScreen({ input, output, completion: () => ({ models: ["deepseek-flash", "deepseek-v4-pro"], policyPatterns: [] }) });
  const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
  return {
    screen,
    type: async (s: string, ms = 5) => {
      input.write(s);
      await tick(ms);
    },
    output: () => written.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ""),
    raw: () => written,
    resize: () => resizeHandlers.forEach((fn) => fn()),
    clear: () => (written = ""),
    tick,
  };
}

test("display widths: ASCII 1, CJK and emoji 2, combining marks 0", () => {
  assert.equal(charWidth("a"), 1);
  assert.equal(charWidth("漢"), 2);
  assert.equal(charWidth("👋"), 2);
  assert.equal(charWidth("́"), 0);
  assert.deepEqual(graphemes("é👩‍💻x"), ["é", "👩‍💻", "x"]);
  assert.equal(textWidth("\x1b[2mhi\x1b[0m 漢"), 5);
  assert.equal(fit("hello world", 8), "hello w…\x1b[0m");
  assert.equal(fit("short", 8), "short");
});

test("Enter sends what was typed, and it's echoed above the input box", async () => {
  const t = fakeTerminal();
  const lines = t.screen.lines()[Symbol.asyncIterator]();
  await t.type("hello there");
  assert.equal(t.screen.inputText(), "hello there");
  await t.type("\r");
  assert.deepEqual(await lines.next(), { done: false, value: "hello there" });
  assert.equal(t.screen.inputText(), "");
  assert.match(t.output(), /> hello there\r\n/);
  t.screen.close();
});

test("while busy, a sent message goes to onBusyInput instead of lines()", async () => {
  const t = fakeTerminal();
  const got: string[] = [];
  t.screen.onBusyInput = (text) => got.push(text);
  await t.type("steer this way\r");
  assert.deepEqual(got, ["steer this way"]);
  t.screen.onBusyInput = undefined;
  t.screen.close();
});

test("a pasted newline is part of the text; only a typed Enter sends", async () => {
  const t = fakeTerminal();
  const lines = t.screen.lines()[Symbol.asyncIterator]();
  await t.type("\x1b[200~first line\rsecond line\x1b[201~");
  assert.equal(t.screen.inputText(), "first line\nsecond line");
  await t.type("\r");
  assert.deepEqual(await lines.next(), { done: false, value: "first line\nsecond line" });
  await t.type("one\x1b\rtwo"); // Alt+Enter
  assert.equal(t.screen.inputText(), "one\ntwo");
  t.screen.close();
});

test("editing keys: arrows, Ctrl+A/E/U/K/W, backspace, and history with up/down", async () => {
  const t = fakeTerminal();
  const lines = t.screen.lines()[Symbol.asyncIterator]();
  await t.type("one two three");
  await t.type("\x17"); // Ctrl+W: delete a word
  assert.equal(t.screen.inputText(), "one two ");
  await t.type("\x01X"); // Ctrl+A, then type at the start
  assert.equal(t.screen.inputText(), "Xone two ");
  await t.type("\x05\x7f\x7f"); // Ctrl+E, two backspaces
  assert.equal(t.screen.inputText(), "Xone tw");
  await t.type("\x1b[D\x1b[D\x0b"); // left twice, Ctrl+K
  assert.equal(t.screen.inputText(), "Xone ");
  await t.type("\x15"); // Ctrl+U
  assert.equal(t.screen.inputText(), "");
  await t.type("first\r");
  await lines.next();
  await t.type("second\r");
  await lines.next();
  await t.type("draft\x1b[A");
  assert.equal(t.screen.inputText(), "second");
  await t.type("\x1b[A");
  assert.equal(t.screen.inputText(), "first");
  await t.type("\x1b[B\x1b[B");
  assert.equal(t.screen.inputText(), "draft", "back to the unsent draft");
  t.screen.close();
});

test("Tab completes slash commands and lists the options when it can't go further", async () => {
  const t = fakeTerminal();
  await t.type("/mod\t");
  assert.equal(t.screen.inputText(), "/model ");
  await t.type("deep\t");
  assert.equal(t.screen.inputText(), "/model deepseek-");
  t.clear();
  await t.type("\t");
  assert.match(t.output(), /deepseek-flash {3}deepseek-v4-pro/);
  t.screen.close();
});

test("ask() takes the answer in the input box and puts the draft back afterwards", async () => {
  const t = fakeTerminal();
  await t.type("my draft");
  const answer = t.screen.ask("  Allow web_fetch of https://x.test/?\n  [y]es / [n]o: ");
  await t.tick();
  assert.equal(t.screen.inputText(), "", "the draft is set aside");
  await t.type("y\r");
  assert.equal(await answer, "y");
  assert.equal(t.screen.inputText(), "my draft");
  assert.match(t.output(), /Allow web_fetch of https:\/\/x\.test\/\?\r?\n? *\[y\]es \/ \[n\]o: y/);

  // An aborted signal (the run was interrupted) answers "" at once.
  const ctrl = new AbortController();
  const pending = t.screen.ask("Allow? ", ctrl.signal);
  ctrl.abort();
  assert.equal(await pending, "");
  t.screen.close();
});

test("choose() shows a menu in the panel: arrows and Enter pick, Esc cancels", async () => {
  const t = fakeTerminal();
  const items = [
    { label: "anthropic", value: "anthropic" },
    { label: "deepseek", value: "deepseek" },
  ];
  const picked = t.screen.choose!("Provider", items, 0);
  await t.type("\x1b[B\r");
  assert.equal(await picked, "deepseek");
  const cancelled = t.screen.choose!("Provider", items, 0);
  await t.type("\x1b", 120); // a lone Esc is recognised after a short wait
  assert.equal(await cancelled, undefined);
  t.screen.close();
});

test("Ctrl+C goes to the interrupt handler; Ctrl+D on an empty line ends the input", async () => {
  const t = fakeTerminal();
  let interrupts = 0;
  t.screen.onInterrupt(() => interrupts++);
  await t.type("\x03");
  assert.equal(interrupts, 1);
  const lines = t.screen.lines()[Symbol.asyncIterator]();
  await t.type("\x04");
  assert.deepEqual(await lines.next(), { done: true, value: undefined });
  t.screen.close();
});

test("output wraps at the screen width, and the panel is redrawn below it", async () => {
  const t = fakeTerminal(20, 10);
  t.clear();
  t.screen.write("abcdefghijklmnopqrstuvwxyz\n");
  const out = t.output();
  assert.match(out, /abcdefghijklmnopqrst\r\nuvwxyz\r\n/, "wrapped at 20 columns");
  assert.match(out, /─{19}/, "panel redrawn");
  t.screen.close();
});

test("after a resize, the cursor position reply is used and never typed into the input", async () => {
  const t = fakeTerminal();
  await t.type("draft");
  t.clear();
  t.resize();
  assert.match(t.raw(), /\x1b\[6n/, "asked the terminal where the cursor is");
  await t.type("\x1b[11;8R");
  assert.equal(t.screen.inputText(), "draft", "the reply isn't input");
  assert.match(t.raw(), /\x1b\[\d+;1H\x1b\[J/, "erased from the panel's top and redrew");

  // Split across two chunks, the reply is still recognised.
  t.resize();
  await t.type("\x1b[1");
  await t.type("2;8R");
  assert.equal(t.screen.inputText(), "draft");

  // When no reply is pending, the same bytes are just keys (no special treatment).
  await t.type("x");
  assert.equal(t.screen.inputText(), "draftx");
  t.screen.close();
});
