// The startup splash: an ASCII `harness` wordmark, a braille spinner, and a live checklist of
// boot phases. renderSplash is pure (lines for a given phase set + frame); createSplash (below)
// drives it on a terminal.

import { createSpinner } from "./spinner.ts";
import type { Terminal } from "./terminal.ts";

const PAD = "   ";

/** The `harness` wordmark (figlet "standard"), pre-indented to line up with the checklist. */
export const SPLASH_LOGO: readonly string[] = [
  PAD + " _                                  ",
  PAD + "| |__   __ _ _ __ _ __   ___ ___ ___ ",
  PAD + "| '_ \\ / _` | '__| '_ \\ / _ / __/ __|",
  PAD + "| | | | (_| | |  | | | |  __\\__ \\__ \\",
  PAD + "|_| |_|\\__,_|_|  |_| |_|\\___|___/___/",
];

/** Braille spinner frames. */
export const SPINNER_BRAILLE: readonly string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export type PhaseState = "pending" | "active" | "done" | "failed";
export interface SplashPhase {
  label: string;
  state: PhaseState;
}

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** The full splash block for the given phases and spinner frame. Pure; no terminal width assumed. */
export function renderSplash(phases: readonly SplashPhase[], frame: number): string[] {
  const spin = SPINNER_BRAILLE[frame % SPINNER_BRAILLE.length];
  const lines: string[] = [""];
  for (const l of SPLASH_LOGO) lines.push(`${CYAN}${l}${RESET}`);
  lines.push("");

  const settled = phases.every((p) => p.state === "done" || p.state === "failed");
  if (!settled) {
    lines.push(`${CYAN}${PAD}${spin} starting up…${RESET}`);
    lines.push("");
  }

  for (const p of phases) {
    if (p.state === "done") lines.push(`${GREEN}${PAD}✓ ${p.label}${RESET}`);
    else if (p.state === "failed") lines.push(`${RED}${PAD}✗ ${p.label}${RESET}`);
    else if (p.state === "active") lines.push(`${CYAN}${PAD}${spin} ${p.label}${RESET}`);
    else lines.push(`${DIM}${PAD}  ${p.label}${RESET}`);
  }
  return lines;
}

export interface SplashHandle {
  /** Update a phase's state (and redraw). */
  set(label: string, state: PhaseState): void;
  /** Stop the animation, honour the minimum display time, then clear (screen mode). */
  finish(): Promise<void>;
}

const MIN_MS = 400; // minimum on-screen time so a fast startup doesn't just flash
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Drive the splash on a terminal. Screen mode animates it via term.notes on a timer and clears on
 * finish; plain line mode prints the logo + a spinner and prints each phase as it settles; batch /
 * non-interactive terminals get a silent no-op.
 */
export function createSplash(term: Terminal, labels: readonly string[]): SplashHandle {
  const start = Date.now();
  const phases: SplashPhase[] = labels.map((label) => ({ label, state: "pending" }));
  const find = (label: string) => phases.find((p) => p.label === label);

  if (!term.interactive) return { set() {}, async finish() {} };

  if (term.screen) {
    let frame = 0;
    const draw = () => term.notes(renderSplash(phases, frame));
    draw();
    const timer = setInterval(() => {
      frame++;
      draw();
    }, 100);
    timer.unref?.();
    return {
      set(label, state) {
        const p = find(label);
        if (p) {
          p.state = state;
          draw();
        }
      },
      async finish() {
        clearInterval(timer);
        const left = MIN_MS - (Date.now() - start);
        if (left > 0) await sleep(left);
        term.notes([]);
      },
    };
  }

  // Plain line mode (interactive, not the full screen): print the logo, animate a spinner, and
  // print each phase as it settles. The logo and phase lines stay in the scrollback.
  term.write(`${SPLASH_LOGO.join("\n")}\n`);
  const spinner = createSpinner();
  spinner.start();
  return {
    set(label, state) {
      const p = find(label);
      if (!p) return;
      p.state = state;
      if (state === "done" || state === "failed") {
        spinner.stop();
        const glyph = state === "done" ? `${GREEN}${PAD}✓` : `${RED}${PAD}✗`;
        term.write(`${glyph} ${label}${RESET}\n`);
        if (phases.some((q) => q.state === "pending" || q.state === "active")) spinner.start();
      }
    },
    async finish() {
      spinner.stop();
      const left = MIN_MS - (Date.now() - start);
      if (left > 0) await sleep(left);
    },
  };
}
