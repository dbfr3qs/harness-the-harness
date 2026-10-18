import { emitKeypressEvents } from "node:readline";
import { PassThrough } from "node:stream";
import { completeSlashCommand } from "./complete.ts";
import { menuKey, renderMenu } from "./menu.ts";
import type { Key, MenuItem, MenuState } from "./menu.ts";
import { SPINNER_FRAMES } from "./spinner.ts";
import type { Terminal, TerminalOptions } from "./terminal.ts";
import { dimText } from "./terminal.ts";

// --- text measurement ------------------------------------------------------------------

const segmenter = new Intl.Segmenter();
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** User-perceived characters, so an emoji or an accented letter moves the cursor once. */
export function graphemes(s: string): string[] {
  return Array.from(segmenter.segment(s), (x) => x.segment);
}

/** Columns a grapheme takes in a terminal: 0, 1 or 2. An approximation of wcwidth. */
export function charWidth(g: string): number {
  const cp = g.codePointAt(0) ?? 0;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (/^\p{M}/u.test(g)) return 0;
  if (/\p{Emoji_Presentation}/u.test(g) || g.includes("️")) return 2;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** Display width of text that may contain ANSI styling. */
export function textWidth(s: string): number {
  return graphemes(s.replace(ANSI, "")).reduce((w, g) => w + charWidth(g), 0);
}

/** Cuts styled text to at most `width` columns, ending with "…" when cut. */
export function fit(s: string, width: number): string {
  if (textWidth(s) <= width) return s;
  let out = "";
  let w = 0;
  for (const part of s.split(/(\x1b\[[0-9;?]*[ -/]*[@-~])/)) {
    if (part.startsWith("\x1b[")) {
      out += part;
      continue;
    }
    for (const g of graphemes(part)) {
      const cw = charWidth(g);
      if (w + cw > width - 1) return `${out}…\x1b[0m`;
      out += g;
      w += cw;
    }
  }
  return `${out}\x1b[0m`;
}

// --- the screen --------------------------------------------------------------------------

type Mode =
  | { kind: "input" }
  | { kind: "ask"; question: string; done: (answer: string) => void; cancellable: boolean }
  | { kind: "menu"; title: string; items: MenuItem<unknown>[]; state: MenuState; done: (state: MenuState) => void };

const MAX_INPUT_ROWS = 8;
const PROMPT = "> ";

export interface ScreenOptions extends TerminalOptions {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

/**
 * The full-screen layout: output scrolls as usual, and below it a panel stays at the bottom with
 * the input box and a status bar. The panel is erased and redrawn around each piece of output
 * (rather than pinned with a terminal scroll region) so that scrollback keeps everything.
 * Typing works at any time; what happens to a prompt sent while the agent is busy is up to
 * onBusyInput.
 */
export function createScreen(opts: ScreenOptions): Terminal {
  const input = opts.input ?? process.stdin;
  const out = opts.output ?? process.stdout;
  const cols = () => Math.max(20, out.columns || 80);
  const rows = () => Math.max(6, out.rows || 24);

  let outCol = 0; // column where output continues; 0 = at the start of a line
  let drawn: { caretRow: number } | undefined; // the panel on screen, and the cursor's row within it
  // Rows the panel occupies, padding included: blank rows above its content keep it on the bottom
  // row of the screen until output fills them. Output lines use up padding; a panel that shrinks
  // (a menu closing) gains padding, so the input box never moves up.
  let reserved = 0;
  let advanced = 0; // rows output moved down by in the last outputBytes()
  let buf: string[] = []; // the input, as graphemes
  let pos = 0; // cursor index into buf
  let mode: Mode = { kind: "input" };
  let stash: { buf: string[]; pos: number } | undefined; // the input set aside while asking
  let pasting = false;
  const history: string[] = [];
  let historyIndex = -1; // -1 = editing a new line
  let historyDraft: string[] = [];
  let statusText = "";
  let noteLines: string[] = [];
  let awaitingPosition = false; // a cursor position report has been requested
  let activityLabel: string | undefined;
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let interrupt: (() => void) | undefined;
  const queue: string[] = [];
  let waiter: ((line: string | null) => void) | undefined;
  let ended = false;
  let closed = false;

  // --- drawing ---------------------------------------------------------------------------

  // Bytes that write `text` into the output area, wrapping it ourselves so the column is known.
  function outputBytes(text: string): string {
    let s = outCol > 0 ? `\x1b[1A\x1b[${outCol + 1}G` : "";
    advanced = outCol > 0 ? -1 : 0;
    const newline = () => {
      s += "\r\n";
      outCol = 0;
      advanced++;
    };
    const width = cols();
    for (const part of text.split(/(\x1b\[[0-9;?]*[ -/]*[@-~])/)) {
      if (part.startsWith("\x1b[")) {
        s += part;
        continue;
      }
      for (const g of graphemes(part)) {
        if (g === "\n" || g === "\r\n") {
          newline();
          continue;
        }
        if (g === "\r") continue;
        if (g === "\t") {
          const spaces = 8 - (outCol % 8);
          s += " ".repeat(Math.min(spaces, width - outCol));
          outCol = Math.min(width, outCol + spaces);
          continue;
        }
        const w = charWidth(g);
        if (w === 0 && g.codePointAt(0)! < 0x20) continue; // other control characters
        if (outCol + w > width) newline();
        s += g;
        outCol += w;
      }
    }
    s += "\x1b[0m";
    // The panel starts on the line after a partly written one.
    if (outCol > 0) {
      s += "\r\n";
      advanced++;
    }
    return s;
  }

  function panel(): { lines: string[]; caretRow: number; caretCol: number } {
    const width = cols() - 1; // never write the last column, so nothing wraps
    const lines: string[] = [];
    if (mode.kind === "menu") {
      for (const line of renderMenu(mode.title, mode.items, mode.state.index)) lines.push(fit(line, width));
    }
    if (mode.kind === "ask") {
      for (const line of wrapPlain(mode.question.replace(/\s+$/, ""), width)) lines.push(line);
    }
    for (const note of noteLines) lines.push(fit(dimText(note), width));
    lines.push(dimText("─".repeat(width)));

    // The input box: wrapped, with the cursor kept in view.
    let caretRow = lines.length;
    let caretCol = PROMPT.length;
    if (mode.kind !== "menu") {
      const prefix = mode.kind === "ask" ? "? " : PROMPT;
      const rowsOut: string[] = [""];
      let col = prefix.length;
      let row = 0;
      let cRow = 0;
      let cCol = col;
      buf.forEach((g, i) => {
        if (i === pos) [cRow, cCol] = [row, col];
        const shown = g === "\n" ? dimText("↵") : g === "\t" ? " " : g;
        const w = g === "\n" || g === "\t" ? 1 : charWidth(g);
        if (col + w > width) {
          rowsOut.push("");
          row++;
          col = 2;
          if (i === pos) [cRow, cCol] = [row, col];
        }
        rowsOut[row] += shown;
        col += w;
      });
      if (pos === buf.length) {
        if (col >= width) {
          rowsOut.push("");
          row++;
          col = 2;
        }
        [cRow, cCol] = [row, col];
      }
      const first = Math.max(0, Math.min(cRow - MAX_INPUT_ROWS + 1, rowsOut.length - MAX_INPUT_ROWS));
      const visible = rowsOut.slice(first, first + MAX_INPUT_ROWS);
      visible.forEach((r, i) => lines.push(`${i === 0 && first === 0 ? `\x1b[1m${prefix}\x1b[0m` : "  "}${r}`));
      caretRow = lines.length - visible.length + (cRow - first);
      caretCol = cCol;
    }

    // The status bar.
    const anim = activityLabel !== undefined ? `${(SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "").padEnd(5)} ${activityLabel}` : "";
    const status = [anim, statusText].filter(Boolean).join(dimText(" · "));
    lines.push(fit(status ? dimText(status) : "", width));

    // Never taller than the screen (a long menu loses its top first).
    const max = rows() - 1;
    if (lines.length > max) {
      const cut = lines.length - max;
      lines.splice(0, cut);
      caretRow = Math.max(0, caretRow - cut);
    }
    // Padding above the content keeps the panel on the bottom row.
    const pad = Math.max(0, Math.min(reserved, rows()) - lines.length);
    return { lines: [...Array<string>(pad).fill(""), ...lines], caretRow: caretRow + pad, caretCol };
  }

  function draw(outputText = ""): void {
    if (closed) return;
    let s = "\x1b[?2026h\x1b[?25l"; // synchronized update (where supported), cursor hidden
    if (drawn) s += `${drawn.caretRow > 0 ? `\x1b[${drawn.caretRow}A` : ""}\r\x1b[J`; // erase the panel
    if (outputText) {
      s += outputBytes(outputText);
      reserved = Math.max(0, reserved - advanced);
    }
    const p = panel();
    reserved = p.lines.length;
    s += p.lines.join("\r\n");
    const up = p.lines.length - 1 - p.caretRow;
    s += `${up > 0 ? `\x1b[${up}A` : ""}\r${p.caretCol > 0 ? `\x1b[${p.caretCol}C` : ""}`;
    if (mode.kind !== "menu") s += "\x1b[?25h";
    s += "\x1b[?2026l";
    drawn = { caretRow: p.caretRow };
    out.write(s);
  }

  // --- input -----------------------------------------------------------------------------

  const insert = (text: string) => {
    const gs = graphemes(text.replace(/\r\n?/g, "\n"));
    buf.splice(pos, 0, ...gs);
    pos += gs.length;
  };
  const setBuffer = (text: string) => {
    buf = graphemes(text);
    pos = buf.length;
  };

  function submit(): void {
    const text = buf.join("");
    if (mode.kind === "ask") {
      mode.done(text);
      return;
    }
    if (text.trim() === "") return;
    if (history.at(-1) !== text) history.push(text);
    historyIndex = -1;
    buf = [];
    pos = 0;
    if (terminal.onBusyInput) {
      draw();
      terminal.onBusyInput(text);
      return;
    }
    draw(`${outCol > 0 ? "\n" : ""}\x1b[1m${PROMPT}\x1b[0m${text}\n`);
    if (waiter) {
      const w = waiter;
      waiter = undefined;
      w(text);
    } else {
      queue.push(text);
    }
  }

  function complete(): void {
    if (pos !== buf.length) return;
    const line = buf.join("");
    const [hits, word] = completeSlashCommand(line, opts.completion());
    if (hits.length === 0) return;
    const common = hits.reduce((a, b) => {
      let i = 0;
      while (i < a.length && a[i] === b[i]) i++;
      return a.slice(0, i);
    });
    if (common.length > word.length) {
      insert(common.slice(word.length));
      draw();
    } else {
      draw(`${dimText(hits.map((h) => h.trim()).join("   "))}\n`);
    }
  }

  function historyMove(dir: -1 | 1): void {
    if (history.length === 0) return;
    if (historyIndex === -1) {
      if (dir === 1) return;
      historyDraft = buf;
      historyIndex = history.length - 1;
    } else {
      historyIndex += dir;
      if (historyIndex >= history.length) {
        historyIndex = -1;
        buf = historyDraft;
        pos = buf.length;
        return;
      }
      historyIndex = Math.max(0, historyIndex);
    }
    setBuffer(history[historyIndex]!);
  }

  function onKey(seq: string | undefined, key: (Key & { meta?: boolean; shift?: boolean }) | undefined): void {
    const k = key ?? {};
    if (k.name === "paste-start") {
      pasting = true;
      return;
    }
    if (k.name === "paste-end") {
      pasting = false;
      draw();
      return;
    }

    if (k.ctrl && k.name === "c") {
      if (mode.kind === "ask" && mode.cancellable) return mode.done("");
      if (mode.kind === "menu") return mode.done({ ...mode.state, done: "cancel" });
      interrupt?.();
      return;
    }

    if (mode.kind === "menu") {
      const next = menuKey(mode.items, mode.state, k);
      if (next.done) return mode.done(next);
      mode.state = next;
      draw();
      return;
    }

    if (pasting) {
      // Inside a paste, Enter is part of the text, not "send".
      if (k.name === "return" || k.name === "enter") insert("\n");
      else if (seq) insert(seq);
      return; // drawn once, at paste-end
    }

    if (k.ctrl) {
      switch (k.name) {
        case "a": pos = 0; break;
        case "e": pos = buf.length; break;
        case "b": pos = Math.max(0, pos - 1); break;
        case "f": pos = Math.min(buf.length, pos + 1); break;
        case "u": buf.splice(0, pos); pos = 0; break;
        case "k": buf.splice(pos); break;
        case "w": {
          let i = pos;
          while (i > 0 && /\s/.test(buf[i - 1]!)) i--;
          while (i > 0 && !/\s/.test(buf[i - 1]!)) i--;
          buf.splice(i, pos - i);
          pos = i;
          break;
        }
        case "d":
          if (buf.length === 0 && mode.kind === "input") return endInput();
          buf.splice(pos, 1);
          break;
        case "l": drawn = undefined; out.write("\x1b[2J\x1b[H"); outCol = 0; break;
        default: return;
      }
      draw();
      return;
    }

    switch (k.name) {
      case "return":
      case "enter":
        if (k.meta || k.shift) insert("\n"); // where the terminal reports them, Alt/Shift+Enter add a line
        else return submit();
        break;
      case "backspace":
        if (pos > 0) buf.splice(--pos, 1);
        break;
      case "delete":
        buf.splice(pos, 1);
        break;
      case "left":
        pos = Math.max(0, pos - 1);
        break;
      case "right":
        pos = Math.min(buf.length, pos + 1);
        break;
      case "home":
        pos = 0;
        break;
      case "end":
        pos = buf.length;
        break;
      case "up":
        historyMove(-1);
        break;
      case "down":
        historyMove(1);
        break;
      case "tab":
        return complete();
      case "escape":
        return;
      default:
        if (!seq || k.meta || /^[\x00-\x1f\x7f]/.test(seq)) return;
        insert(seq);
    }
    draw();
  }

  // After a resize, terminals move lines around in different ways, so the panel's position is
  // asked for rather than assumed: the terminal reports the cursor's row (the cursor is at the
  // caret), which gives the panel's top. It's erased from there and redrawn on the bottom row.
  function repositionAt(caretScreenRow: number): void {
    clearTimeout(resizeFallback);
    const top = Math.max(1, caretScreenRow - (drawn?.caretRow ?? 0));
    out.write(`\x1b[${top};1H\x1b[J`);
    drawn = undefined;
    reserved = rows() - top + 1;
    draw();
  }

  function endInput(): void {
    ended = true;
    if (waiter) {
      const w = waiter;
      waiter = undefined;
      w(null);
    }
  }

  function setMode(next: Mode): void {
    mode = next;
    draw();
  }

  // --- start -------------------------------------------------------------------------------

  // Input passes through a filter before Node decodes it into keys: the terminal's reply to a
  // cursor position request ("ESC [ row ; col R") is taken out there, because Node's decoder
  // misreads it (as F3 plus a stray "R" when the numbers have two digits).
  const keys = new PassThrough();
  let held = ""; // the start of a possible reply, split across chunks
  let heldTimer: ReturnType<typeof setTimeout> | undefined;
  const onData = (chunk: Buffer | string) => {
    clearTimeout(heldTimer);
    let s = held + String(chunk);
    held = "";
    if (awaitingPosition) {
      s = s.replace(/\x1b\[(\d+);(\d+)R/, (_m, row: string) => {
        awaitingPosition = false;
        queueMicrotask(() => repositionAt(Number(row)));
        return "";
      });
      const tail = awaitingPosition ? /\x1b(\[[\d;]*)?$/.exec(s) : null;
      if (tail) {
        held = tail[0];
        s = s.slice(0, tail.index);
        heldTimer = setTimeout(() => onData(""), 50); // not a reply after all: pass it on
      }
    }
    if (s) keys.write(s);
  };
  // Esc is reported once no more of an escape sequence arrives; 50 ms is plenty for a terminal.
  emitKeypressEvents(keys, { escapeCodeTimeout: 50 } as never);
  keys.on("keypress", onKey);
  input.setRawMode?.(true);
  input.on("data", onData);
  input.resume();
  let resizeFallback: ReturnType<typeof setTimeout> | undefined;
  const onResize = () => {
    awaitingPosition = true;
    out.write("\x1b[6n"); // where is the cursor now? (the reply is picked out in onData)
    // A terminal that doesn't answer: redraw in place, without padding.
    clearTimeout(resizeFallback);
    resizeFallback = setTimeout(() => {
      if (!awaitingPosition) return;
      awaitingPosition = false;
      reserved = 0;
      draw();
    }, 300);
  };
  out.on("resize", onResize);
  out.write("\x1b[?2004h"); // bracketed paste: pasted newlines arrive as text, not as Enter
  // Start with the input box on the bottom row: scroll what's on screen into the scrollback,
  // then fill the screen with the panel's padding. Output then grows down from the top.
  out.write(`${"\r\n".repeat(rows() - 1)}\x1b[${rows() - 1}A`);
  reserved = rows();
  draw();

  const terminal: Terminal = {
    screen: true,
    write(text) {
      if (text) draw(text);
    },
    endLine() {
      if (outCol > 0) draw("\n");
    },
    activity(label) {
      activityLabel = label;
      if (label !== undefined && !timer) {
        timer = setInterval(() => {
          frame++;
          draw();
        }, 150);
      } else if (label === undefined && timer) {
        clearInterval(timer);
        timer = undefined;
        frame = 0;
      }
      draw();
    },
    status(text) {
      if (text === statusText) return;
      statusText = text;
      draw();
    },
    notes(lines) {
      noteLines = lines;
      draw();
    },
    ask(question, signal) {
      if (signal?.aborted) return Promise.resolve("");
      return new Promise((resolve) => {
        stash = { buf, pos };
        buf = [];
        pos = 0;
        const finish = (answer: string) => {
          signal?.removeEventListener("abort", onAbort);
          if (stash) ({ buf, pos } = stash);
          stash = undefined;
          mode = { kind: "input" };
          // Keep the question and answer in the output, as a record.
          draw(`${dimText(`${question.replace(/\s+$/, "")} ${answer}`)}\n`);
          resolve(answer);
        };
        const onAbort = () => finish("");
        signal?.addEventListener("abort", onAbort, { once: true });
        setMode({ kind: "ask", question, done: finish, cancellable: !signal });
      });
    },
    choose<T>(title: string, items: MenuItem<T>[], initial: number) {
      const first = items[initial] && !items[initial].disabled ? initial : items.findIndex((i) => !i.disabled);
      if (first < 0) return Promise.resolve(undefined);
      return new Promise<T | undefined>((resolve) => {
        setMode({
          kind: "menu",
          title,
          items: items as MenuItem<unknown>[],
          state: { index: first },
          done: (state) => {
            mode = { kind: "input" };
            draw();
            resolve(state.done === "select" ? items[state.index]!.value : undefined);
          },
        });
      });
    },
    async *lines() {
      while (true) {
        if (queue.length) {
          yield queue.shift()!;
          continue;
        }
        if (ended) return;
        const line = await new Promise<string | null>((r) => (waiter = r));
        if (line === null) return;
        yield line;
      }
    },
    ready() {},
    onInterrupt(handler) {
      interrupt = handler;
    },
    onBusyInput: undefined,
    inputText: () => buf.join(""),
    setInput(text) {
      setBuffer(text);
      draw();
    },
    close() {
      if (closed) return;
      if (timer) clearInterval(timer);
      // Leave the screen tidy: the panel erased and the cursor where output would continue.
      let s = drawn ? `${drawn.caretRow > 0 ? `\x1b[${drawn.caretRow}A` : ""}\r\x1b[J` : "";
      if (outCol > 0) s += `\x1b[1A\x1b[${outCol + 1}G\r\n`;
      closed = true;
      out.write(`${s}\x1b[?2004l\x1b[?25h`);
      input.off("data", onData);
      clearTimeout(heldTimer);
      clearTimeout(resizeFallback);
      keys.off("keypress", onKey);
      keys.end();
      out.off("resize", onResize);
      input.setRawMode?.(false);
      input.pause();
    },
  };
  return terminal;
}

// Splits plain text into lines of at most `width` columns, breaking at spaces where it can.
function wrapPlain(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      if (textWidth(line + word) <= width) {
        line += word;
        continue;
      }
      if (line.trim()) lines.push(line.trimEnd());
      line = word.trimStart();
      while (textWidth(line) > width) {
        const gs = graphemes(line);
        let w = 0;
        let i = 0;
        while (i < gs.length && w + charWidth(gs[i]!) <= width) w += charWidth(gs[i++]!);
        lines.push(gs.slice(0, i).join(""));
        line = gs.slice(i).join("");
      }
    }
    lines.push(line);
  }
  return lines;
}
