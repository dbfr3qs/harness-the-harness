import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTranscriptLogger } from "../src/log.ts";

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-log-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("writes one { ts, kind, data } object per line, in order, creating the directory", async () => {
  const path = join(dir, "nested", "deeper", "t.jsonl");
  const logger = createTranscriptLogger(path);
  logger.log("request", { n: 1 });
  logger.log("response", { n: 2 });
  logger.log("tool_call", { n: 3 });
  await logger.flush();
  const lines = (await readFile(path, "utf8")).trimEnd().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.kind, l.data.n]), [["request", 1], ["response", 2], ["tool_call", 3]]);
  assert.ok(lines.every((l) => !Number.isNaN(Date.parse(l.ts))));
});

test("scrubs secrets from every line", async () => {
  const path = join(dir, "secret.jsonl");
  const logger = createTranscriptLogger(path, { secrets: ["sk-ant-SECRET"] });
  logger.log("error", { message: "oops sk-ant-SECRET oops" });
  await logger.flush();
  const text = await readFile(path, "utf8");
  assert.ok(!text.includes("sk-ant-SECRET"));
  assert.match(text, /\[redacted\]/);
});

test("failures warn once and never throw", async () => {
  const blocker = join(dir, "a-file");
  await writeFile(blocker, "");
  const warnings: string[] = [];
  const logger = createTranscriptLogger(join(blocker, "t.jsonl"), { warn: (m) => warnings.push(m) });
  logger.log("request", {});
  logger.log("response", {});
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  logger.log("error", circular);
  await logger.flush();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /transcript logging .* failed/);
});
