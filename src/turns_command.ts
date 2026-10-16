export interface TurnsCommandResult {
  output: string;
  maxTurns?: number; // set when the limit changed; Infinity for unlimited
}

/** "10 model call(s)" or "unlimited". */
export function describeTurns(n: number): string {
  return Number.isFinite(n) ? `${n} model call(s)` : "unlimited";
}

const STOP_HINT = "press Ctrl+C to stop a run";

/** /turns shows the model-call limit per message; /turns <n> or /turns unlimited changes it for this session. */
export function runTurnsCommand(args: string, current: number): TurnsCommandResult {
  const arg = args.trim().toLowerCase();
  const now = (n: number) => `Max turns: ${describeTurns(n)}${Number.isFinite(n) ? " per message" : ` (${STOP_HINT})`}`;
  if (arg === "") {
    return { output: `${now(current)}. /turns <n> or /turns unlimited to change it for this session.` };
  }
  let n: number;
  if (arg === "unlimited" || arg === "off") {
    n = Infinity;
  } else if (/^\d+$/.test(arg) && Number(arg) >= 1 && Number.isSafeInteger(Number(arg))) {
    n = Number(arg);
  } else {
    return { output: `Not changed: /turns needs a whole number of 1 or more, or "unlimited" (got "${args.trim()}").` };
  }
  if (n === current) return { output: `Max turns is already ${describeTurns(n)}.` };
  return {
    output: `${now(n)} (was ${describeTurns(current)}). Lasts for this session; set MAX_TURNS in .env to change the default.`,
    maxTurns: n,
  };
}
