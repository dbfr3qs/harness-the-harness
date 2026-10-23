// The startup splash: an ASCII `harness` wordmark, a braille spinner, and a live checklist of
// boot phases. renderSplash is pure (lines for a given phase set + frame); createSplash (below)
// drives it on a terminal.

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
