import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTokenCount, runMaxTokensCommand } from "../src/max_tokens_command.ts";

test("token counts can be written plainly, with separators, or with k", () => {
  assert.deepEqual(["16000", "16,000", "16_000", "16k", "16K", "1.5k", " 32k "].map(parseTokenCount), [16000, 16000, 16000, 16000, 16000, 1500, 32000]);
  for (const bad of ["0", "-5", "lots", "1.5", "16m", "", "k"]) assert.equal(parseTokenCount(bad), undefined, bad);
});

test("/maxtokens shows the limit, and the model's ceiling when known", () => {
  assert.equal(
    runMaxTokensCommand("", 4096, "claude-haiku-5-5", 128_000).output,
    "Max tokens: 4,096 per response (claude-haiku-5-5 can write up to 128,000). Thinking counts toward it. /maxtokens <n> (e.g. 16k) to change it for this session.",
  );
  assert.match(runMaxTokensCommand("", 4096, "custom").output, /^Max tokens: 4,096 per response\. Thinking/);
});

test("/maxtokens <n> sets it, within what the model can write", () => {
  assert.deepEqual(runMaxTokensCommand("16k", 4096, "m", 128_000), {
    output: "Max tokens: 16,000 per response (was 4,096). Lasts for this session; /defaults save keeps it.",
    maxTokens: 16_000,
  });
  assert.deepEqual(runMaxTokensCommand("200000", 4096, "claude-haiku-5-5", 128_000), {
    output: "Not changed: claude-haiku-5-5 can write at most 128,000 tokens per response.",
  });
  assert.equal(runMaxTokensCommand("500000", 4096, "custom").maxTokens, 500_000, "no ceiling known: accepted");
  assert.deepEqual(runMaxTokensCommand("4096", 4096, "m"), { output: "Max tokens is already 4,096." });
  assert.match(runMaxTokensCommand("big", 4096, "m").output, /^Not changed: \/maxtokens needs a number of tokens/);
});
