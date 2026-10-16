export interface TurnsCommandResult {
  output: string;
  maxTurns?: number; // set when the limit changed
}

/** /turns shows the model-call limit per message; /turns <n> changes it for this session. */
export function runTurnsCommand(args: string, current: number): TurnsCommandResult {
  const arg = args.trim();
  if (arg === "") {
    return { output: `Max turns: ${current} model call(s) per message. /turns <n> to change it for this session.` };
  }
  if (!/^\d+$/.test(arg) || Number(arg) < 1 || !Number.isSafeInteger(Number(arg))) {
    return { output: `Not changed: /turns needs a whole number of 1 or more (got "${arg}").` };
  }
  const n = Number(arg);
  if (n === current) return { output: `Max turns is already ${n}.` };
  return {
    output: `Max turns: ${n} model call(s) per message (was ${current}). Lasts for this session; set MAX_TURNS in .env to change the default.`,
    maxTurns: n,
  };
}
