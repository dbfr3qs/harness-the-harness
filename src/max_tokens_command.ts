export interface MaxTokensCommandResult {
  output: string;
  maxTokens?: number; // set when the limit changed
}

/** "16000", "16,000", "16k" or "1.5k" -> a whole number of tokens; undefined if it isn't one. */
export function parseTokenCount(text: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*(k?)$/i.exec(text.trim().replace(/[,_]/g, ""));
  if (!m) return undefined;
  const n = Number(m[1]) * (m[2] ? 1000 : 1);
  return Number.isSafeInteger(n) && n >= 1 ? n : undefined;
}

const fmt = (n: number) => n.toLocaleString("en-US");

/**
 * /maxtokens shows max_tokens per response; /maxtokens <n> changes it for this session.
 * `modelMax` is the most the current model can write, when known.
 */
export function runMaxTokensCommand(args: string, current: number, model: string, modelMax?: number): MaxTokensCommandResult {
  const ceiling = modelMax ? ` (${model} can write up to ${fmt(modelMax)})` : "";
  if (args.trim() === "") {
    return {
      output: `Max tokens: ${fmt(current)} per response${ceiling}. Thinking counts toward it. /maxtokens <n> (e.g. 16k) to change it for this session.`,
    };
  }
  const n = parseTokenCount(args);
  if (n === undefined) return { output: `Not changed: /maxtokens needs a number of tokens of 1 or more, like 16000 or 16k (got "${args.trim()}").` };
  if (modelMax && n > modelMax) return { output: `Not changed: ${model} can write at most ${fmt(modelMax)} tokens per response.` };
  if (n === current) return { output: `Max tokens is already ${fmt(n)}.` };
  return { output: `Max tokens: ${fmt(n)} per response (was ${fmt(current)}). Lasts for this session; /defaults save keeps it.`, maxTokens: n };
}
