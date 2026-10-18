import { createInterface } from "node:readline/promises";
import type { CompletionState } from "./complete.ts";
import { completeSlashCommand } from "./complete.ts";
import { selectFromMenu } from "./menu.ts";
import type { MenuItem } from "./menu.ts";
import { createSpinner } from "./spinner.ts";

/**
 * Everything the REPL needs from the terminal. Two implementations: the full-screen layout
 * (src/screen.ts), with a fixed input box and status bar, and this plain line mode, used when
 * input or output isn't a terminal or with --plain.
 */
export interface Terminal {
  /** True for the full-screen layout. */
  readonly screen: boolean;
  /** Writes output; may be part of a line (streamed text). */
  write(text: string): void;
  /** Ends the current output line, if one is in progress. */
  endLine(): void;
  /** Shows that the agent is busy (an animation and a label), or idle when undefined. */
  activity(label: string | undefined): void;
  /** The status bar's text (screen only). */
  status(text: string): void;
  /** Lines shown above the input box, such as messages waiting for the model (screen only). */
  notes(lines: string[]): void;
  /** Asks a question and resolves with the answer; "" if cancelled or the signal aborts. */
  ask(question: string, signal?: AbortSignal): Promise<string>;
  /** A menu, where one can be shown. */
  choose?: <T>(title: string, items: MenuItem<T>[], initial: number) => Promise<T | undefined>;
  /** Prompts entered while idle. */
  lines(): AsyncIterable<string>;
  /** Shows the prompt again after a command (line mode). */
  ready(): void;
  /** Ctrl+C handler. */
  onInterrupt(handler: () => void): void;
  /**
   * Where text submitted while the agent is busy goes (screen only). When unset, submissions
   * wait for lines().
   */
  onBusyInput: ((text: string) => void) | undefined;
  /** The text being typed, and ways to clear or replace it. */
  inputText(): string;
  setInput(text: string): void;
  close(): void;
}

export interface TerminalOptions {
  completion: () => CompletionState;
}

export const dimText = (s: string) => `\x1b[2m${s}\x1b[0m`;

/**
 * A non-interactive terminal for a single prompt, used by --prompt-file (e.g. running the harness
 * as an agent inside an ExploitGym container). It feeds the prompt to the REPL loop once, writes
 * the model's output to stdout with colour stripped, and shows nothing else; the loop runs the one
 * prompt and then exits at end of input. Pair it with --unattended so tool calls aren't blocked
 * waiting for an approval no one is there to give.
 */
export function createBatchTerminal(prompt: string, out: (text: string) => void = (t) => void process.stdout.write(t)): Terminal {
  let atLineStart = true;
  const write = (text: string) => {
    if (text === "") return;
    out(text.replace(/\x1b\[[0-9;]*m/g, ""));
    atLineStart = text.endsWith("\n");
  };
  const endLine = () => {
    if (!atLineStart) write("\n");
  };
  async function* once(): AsyncGenerator<string> {
    yield prompt;
  }
  return {
    screen: false,
    write,
    endLine,
    activity() {},
    status() {},
    notes() {},
    async ask() {
      return ""; // unattended mode approves before asking, so this is never reached in practice
    },
    lines: () => once(),
    ready() {},
    onInterrupt(handler) {
      process.on("SIGINT", handler);
      process.on("SIGTERM", handler);
    },
    onBusyInput: undefined,
    inputText: () => "",
    setInput() {},
    close() {},
  };
}

/** The original readline REPL: output scrolls, the prompt follows it, and dots show while waiting. */
export function createLineTerminal(opts: TerminalOptions): Terminal {
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: (line: string) => completeSlashCommand(line, opts.completion()),
  });
  // With piped input, stdin can hit EOF (closing readline) while buffered lines are still being processed.
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });
  rl.setPrompt("> ");

  // Streamed text arrives in pieces, so track whether the cursor is at the start of a line.
  // The spinner redraws its line with \r, so it must only ever start on an empty line.
  const spinner = createSpinner();
  let atLineStart = true;
  const write = (text: string) => {
    if (text === "") return;
    spinner.stop();
    process.stdout.write(tty ? text : text.replace(/\x1b\[[0-9;]*m/g, ""));
    atLineStart = text.endsWith("\n");
  };
  const endLine = () => {
    if (!atLineStart) write("\n");
  };

  return {
    screen: false,
    write,
    endLine,
    activity(label) {
      if (label === undefined) return spinner.stop();
      endLine();
      spinner.start();
    },
    status() {},
    notes() {},
    async ask(question, signal) {
      spinner.stop();
      endLine();
      try {
        return await rl.question(question, signal ? { signal } : {});
      } catch {
        return ""; // input closed, or the run was interrupted
      }
    },
    ...(tty
      ? {
          choose: <T>(title: string, items: MenuItem<T>[], initial: number) =>
            selectFromMenu(process.stdin, process.stdout, title, items, initial),
        }
      : {}),
    lines: () => rl,
    ready() {
      if (!closed) rl.prompt();
    },
    onInterrupt(handler) {
      rl.on("SIGINT", handler);
    },
    onBusyInput: undefined,
    inputText: () => rl.line,
    setInput(text) {
      rl.write(null, { ctrl: true, name: "e" }); // to the end of the line,
      rl.write(null, { ctrl: true, name: "u" }); // then delete back to the start
      if (text) rl.write(text);
    },
    close() {
      spinner.stop();
      rl.close();
    },
  };
}
