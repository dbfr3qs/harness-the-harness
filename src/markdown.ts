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

export function createMarkdownStream(): MarkdownStream {
  // Unprocessed input. Always either empty or starting at an unclosed marker.
  let held = "";

  const process = (): string => {
    let out = "";
    for (;;) {
      const open = held.indexOf("`");
      if (open === -1) {
        out += held;
        held = "";
        return out;
      }
      out += held.slice(0, open);
      held = held.slice(open);
      const close = held.indexOf("`", 1);
      const nl = held.indexOf("\n", 1);
      if (nl !== -1 && (close === -1 || nl < close)) {
        // A span never crosses a newline: the opening backtick is literal.
        out += "`";
        held = held.slice(1);
        continue;
      }
      if (close === -1) return out; // span still open on this line: hold the tail
      const inner = held.slice(1, close);
      out += inner === "" ? "``" : CODE + inner + RESET;
      held = held.slice(close + 1);
    }
  };

  return {
    write(delta: string): string {
      held += delta;
      return process();
    },
    flush(): string {
      const out = held;
      held = "";
      return out;
    },
  };
}
