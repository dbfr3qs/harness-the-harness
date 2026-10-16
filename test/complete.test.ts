import { test } from "node:test";
import assert from "node:assert/strict";
import { completeSlashCommand } from "../src/complete.ts";

const state = { models: ["deepseek-flash", "deepseek-v4-pro"], policyPatterns: ["docs.example.com", "*.ngrok.io"] };
const complete = (line: string) => completeSlashCommand(line, state);

test("command names complete from / and from a prefix, with a trailing space", () => {
  assert.deepEqual(complete("/"), [["/exit ", "/reset ", "/history ", "/policy ", "/provider ", "/model ", "/thinking ", "/turns "], "/"]);
  assert.deepEqual(complete("/p"), [["/policy ", "/provider "], "/p"]);
  assert.deepEqual(complete("/pr"), [["/provider "], "/pr"]);
  assert.deepEqual(complete("/nope"), [[], "/nope"]);
});

test("ordinary messages are never completed", () => {
  assert.deepEqual(complete("what is /model"), [[], "what is /model"]);
  assert.deepEqual(complete(""), [[], ""]);
});

test("/provider and /model complete their arguments", () => {
  assert.deepEqual(complete("/provider "), [["anthropic ", "deepseek "], ""]);
  assert.deepEqual(complete("/provider d"), [["deepseek "], "d"]);
  assert.deepEqual(complete("/model deepseek-v"), [["deepseek-v4-pro "], "deepseek-v"]);
  assert.deepEqual(complete("/model deepseek-flash "), [[], ""], "nothing after the model");
  assert.deepEqual(complete("/thinking o"), [["on ", "off "], "o"]);
  assert.deepEqual(complete("/thinking of"), [["off "], "of"]);
});

test("/policy completes subcommands, actions, limits and existing rule patterns", () => {
  assert.deepEqual(complete("/policy r"), [["remove ", "reload "], "r"]);
  assert.deepEqual(complete("/policy default "), [["allow ", "ask ", "deny "], ""]);
  assert.deepEqual(complete("/policy limit f"), [["fetches "], "f"]);
  assert.deepEqual(complete("/policy limit url o"), [["off "], "o"]);
  assert.deepEqual(complete("/policy remove "), [["docs.example.com ", "*.ngrok.io ", "#1 ", "#2 "], ""]);
  assert.deepEqual(complete("/policy deny *"), [["*.ngrok.io "], "*"]);
  assert.deepEqual(complete("/policy save "), [[], ""]);
});

test("extra spaces between words don't confuse it", () => {
  assert.deepEqual(complete("/policy   default  a"), [["allow ", "ask "], "a"]);
});
