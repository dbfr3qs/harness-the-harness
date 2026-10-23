// Streaming Markdown -> ANSI renderer. Pure: no terminal access, timers, or globals.

export const RESET = "\x1b[0m";
export const CODE = "\x1b[33m";
export const BOLD = "\x1b[1m";
export const ITALIC = "\x1b[3m";
export const HEADING = "\x1b[1;36m";
export const LINK = "\x1b[4m";
export const DIM = "\x1b[2m";

export type MarkdownStream = {
  /** Returns ANSI bytes safe to emit now; the ambiguous tail is held. */
  write(delta: string): string;
  /** Returns the held remainder (unmatched markers literal) and resets. */
  flush(): string;
};

type Step = { out: string; len: number } | "literal" | "more";

const isSpace = (c: string | undefined): boolean => c === undefined || /\s/.test(c);
const isWord = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9]/.test(c);

// Re-assert a style after any nested reset so the outer span survives inner spans.
const styled = (style: string, inner: string): string =>
  style + renderInline(inner).split(RESET).join(RESET + style) + RESET;

/**
 * Try to resolve the span opening at s[i]. "more" means the line is still open and
 * the decision could change with more input; spans never cross a newline, so a
 * newline (or end of input when final) turns an unresolved opener into a literal.
 */
function resolve(s: string, i: number, final: boolean, prev: string | undefined): Step {
  const c = s[i];
  const nl = s.indexOf("\n", i);
  const end = nl === -1 ? s.length : nl;
  const unresolved: Step = nl === -1 && !final ? "more" : "literal";

  if (c === "`") {
    const close = s.indexOf("`", i + 1);
    if (close !== -1 && close < end) {
      const inner = s.slice(i + 1, close);
      return { out: inner === "" ? "``" : CODE + inner + RESET, len: close + 1 - i };
    }
    return unresolved;
  }

  if (c === "[") {
    const rb = s.indexOf("]", i + 1);
    if (rb === -1 || rb >= end) return unresolved;
    if (rb + 1 >= s.length) return unresolved;
    if (s[rb + 1] !== "(") return "literal";
    const rp = s.indexOf(")", rb + 2);
    if (rp === -1 || rp >= end) return unresolved;
    const text = s.slice(i + 1, rb);
    const url = s.slice(rb + 2, rp);
    if (text === "") return "literal";
    return { out: styled(LINK, text) + " " + DIM + "(" + url + ")" + RESET, len: rp + 1 - i };
  }

  // "*" or "_"
  if (i + 1 >= s.length && !final) return "more";
  if (c === "_" && isWord(prev)) return "literal";
  const double = s[i + 1] === c;
  const m = double ? c + c : c;
  const start = i + m.length;
  if (start >= s.length && !final) return "more";
  if (isSpace(s[start]) || s[start] === c) return "literal";
  for (let j = start; j < end; j++) {
    if (s[j] !== c || isSpace(s[j - 1])) continue;
    if (double) {
      if (s[j + 1] !== c) {
        if (j + 1 >= s.length && !final) return "more";
        continue;
      }
      return { out: styled(BOLD, s.slice(start, j)), len: j + 2 - i };
    }
    if (j + 1 >= s.length && !final) return "more";
    if (s[j + 1] === c || s[j - 1] === c) continue;
    if (c === "_" && isWord(s[j + 1])) continue;
    return { out: styled(ITALIC, s.slice(start, j)), len: j + 1 - i };
  }
  return unresolved;
}

const OPENERS = /[`*_\[]/;

/** One inline pass. `rest` is the held tail (starts at an unresolved opener). */
function run(s: string, final: boolean, prev: string | undefined): { out: string; rest: string; prev: string | undefined } {
  let out = "";
  let i = 0;
  for (;;) {
    const m = OPENERS.exec(s.slice(i));
    if (!m) {
      out += s.slice(i);
      if (s.length > i) prev = s[s.length - 1];
      return { out, rest: "", prev };
    }
    const at = i + m.index;
    if (at > i) {
      out += s.slice(i, at);
      prev = s[at - 1];
    }
    const r = resolve(s, at, final, prev);
    if (r === "more") return { out, rest: s.slice(at), prev };
    if (r === "literal") {
      out += s[at];
      prev = s[at];
      i = at + 1;
    } else {
      out += r.out;
      prev = s[at + r.len - 1];
      i = at + r.len;
    }
  }
}

/** Whole-string inline pass (code, emphasis, links); unresolved markers stay literal. */
export function renderInline(text: string): string {
  return run(text, true, undefined).out;
}

type Kind = "text" | "heading" | "rule";
type Start =
  | "more"
  | "blank"
  | { mode: "line" }
  | { mode: "inline"; prefix: string; rest: string; kind: Kind };

const RULE = /^(?:-{3,}|\*{3,}|_{3,})$/;
const RULE_TEXT = DIM + "─".repeat(32) + RESET;

/**
 * Classify a line from the characters seen so far. "more" means the start marker is
 * still ambiguous; `complete` (newline seen or final) forces a decision.
 */
function classify(buf: string, complete: boolean): Start {
  const indent = /^[ \t]*/.exec(buf)![0];
  const t = buf.slice(indent.length);
  const pad = " ".repeat(Math.floor(indent.length / 2) * 2);
  const para: Start = { mode: "inline", prefix: "", rest: buf, kind: "text" };
  const undecided: Start = complete ? para : "more";
  if (t === "") return complete ? "blank" : "more";
  const c = t[0];
  if (c === "#") {
    const m = /^#+/.exec(t)![0];
    if (m.length > 6) return para;
    if (t.length === m.length) return undecided;
    return t[m.length] === " " ? { mode: "line" } : para;
  }
  if (c === ">") {
    if (t.length === 1) return undecided;
    return t[1] === " " ? { mode: "inline", prefix: DIM + "│ " + RESET, rest: t.slice(2), kind: "text" } : para;
  }
  if (c === "-" || c === "*" || c === "_" || c === "+") {
    let r = 1;
    while (t[r] === c) r++;
    if (c !== "+" && r >= 3) return { mode: "line" };
    if (t.length === r) return undecided;
    if (r === 1 && c !== "_" && t[1] === " ") return { mode: "inline", prefix: pad + "• ", rest: t.slice(2), kind: "text" };
    return para;
  }
  if (c >= "0" && c <= "9") {
    const d = /^\d+/.exec(t)![0];
    if (t.length === d.length) return undecided;
    if (t[d.length] !== ".") return para;
    if (t.length === d.length + 1) return undecided;
    return t[d.length + 1] === " " ? { mode: "inline", prefix: pad + d + ". ", rest: t.slice(d.length + 2), kind: "text" } : para;
  }
  return para;
}

export function createMarkdownStream(): MarkdownStream {
  let mode: "start" | "inline" | "line" = "start";
  let buf = ""; // start: undecided line prefix; line: whole buffered line
  let held = ""; // inline: unresolved tail
  let prev: string | undefined;
  let started = false;
  let pendingBlank = false;
  let prevKind: Kind = "text";

  // Separator owed before a new block line (also records its kind).
  const sep = (kind: Kind): string => {
    let out = "";
    if (started) {
      const blank = pendingBlank || kind !== "text" || prevKind !== "text";
      out = blank ? "\n\n" : "\n";
    }
    started = true;
    pendingBlank = false;
    prevKind = kind;
    return out;
  };

  const finishLine = (): string => {
    const line = buf;
    buf = "";
    const t = line.trim();
    if (RULE.test(t)) return sep("rule") + RULE_TEXT;
    const h = /^\s*#{1,6} +(.*)$/.exec(line);
    if (h) {
      const text = h[1].replace(/(^|\s+)#+\s*$/, "").trim();
      if (text === "") {
        if (started) pendingBlank = true;
        return "";
      }
      // Inner resets re-open HEADING; drop the empty trailing HEADING+RESET pair.
      const body = styled(HEADING, text);
      const empty = HEADING + RESET;
      return sep("heading") + (body.endsWith(empty) && body.length > empty.length * 2 ? body.slice(0, -empty.length) : body);
    }
    return sep("text") + renderInline(line);
  };

  const feed = (input: string, final: boolean): string => {
    let data = input;
    let out = "";
    for (;;) {
      const nl = data.indexOf("\n");
      const seg = nl === -1 ? data : data.slice(0, nl);
      const complete = nl !== -1 || final;
      if (mode === "inline") {
        const r = run(held + seg, complete, prev);
        out += r.out + (complete ? r.rest : "");
        held = complete ? "" : r.rest;
        prev = r.prev;
        if (nl === -1) break;
        mode = "start";
        prev = undefined;
        data = data.slice(nl + 1);
      } else if (mode === "line") {
        buf += seg;
        if (nl === -1) {
          if (final) out += finishLine();
          break;
        }
        out += finishLine();
        mode = "start";
        data = data.slice(nl + 1);
      } else {
        buf += seg;
        const c = classify(buf, complete);
        if (c === "more") break;
        const after = nl === -1 ? "" : data.slice(nl);
        if (c === "blank") {
          if (started) pendingBlank = true;
          buf = "";
          if (nl === -1) break;
          data = after.slice(1);
        } else if ("prefix" in c) {
          out += sep(c.kind) + c.prefix;
          buf = "";
          mode = "inline";
          prev = undefined;
          data = c.rest + after;
        } else {
          mode = "line";
          // buf already holds the line so far; continue it with the remainder.
          data = after;
          if (nl === -1) {
            if (final) out += finishLine();
            break;
          }
        }
      }
    }
    if (final) {
      mode = "start";
      buf = "";
      held = "";
      prev = undefined;
      started = false;
      pendingBlank = false;
      prevKind = "text";
    }
    return out;
  };

  return {
    write: (delta) => feed(delta, false),
    flush: () => feed("", true),
  };
}
