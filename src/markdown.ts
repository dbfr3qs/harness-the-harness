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

export function createMarkdownStream(): MarkdownStream {
  // Unprocessed input. Always either empty or starting at an unresolved marker.
  let held = "";
  let prev: string | undefined;

  return {
    write(delta: string): string {
      const r = run(held + delta, false, prev);
      held = r.rest;
      prev = r.prev;
      return r.out;
    },
    flush(): string {
      const r = run(held, true, prev);
      held = "";
      prev = undefined;
      return r.out + r.rest;
    },
  };
}
