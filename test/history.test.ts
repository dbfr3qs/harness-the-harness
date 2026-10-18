import { test } from "node:test";
import assert from "node:assert/strict";
import { addUserText } from "../src/history.ts";
import type { Message } from "../src/types.ts";

test("undo removes a new prompt, even after text was added to it", () => {
  const messages: Message[] = [{ role: "user", content: "earlier" }, { role: "assistant", content: [{ type: "text", text: "ok" }] }];
  const undo = addUserText(messages, "new prompt");
  // The agent adds a message typed during the run to the same user message.
  const last = messages.at(-1)!;
  last.content = [{ type: "text", text: "new prompt" }, { type: "text", text: "typed while busy" }];
  undo();
  assert.equal(messages.length, 2);
});

test("undo after tool results trims back exactly, leaving the results", () => {
  const results: Message = { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "r" }] };
  const messages: Message[] = [results];
  const undo = addUserText(messages, "continue");
  (results.content as unknown[]).push({ type: "text", text: "typed while busy" });
  undo();
  assert.deepEqual(results.content, [{ type: "tool_result", tool_use_id: "t1", content: "r" }]);
});
