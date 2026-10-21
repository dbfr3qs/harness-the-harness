import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSpeed, tokensPerSec } from "../src/token_speed.ts";

test("tokensPerSec converts tokens over milliseconds to tokens/second", () => {
  assert.equal(tokensPerSec(100, 200), 500);
});

test("tokensPerSec guards zero or negative elapsed time", () => {
  assert.equal(tokensPerSec(40, 0), 0);
  assert.equal(tokensPerSec(40, -5), 0);
});

test("tokensPerSec is zero for zero tokens", () => {
  assert.equal(tokensPerSec(0, 100), 0);
});

test("formatSpeed renders prefill and decode, k-suffix for thousands", () => {
  assert.deepEqual(formatSpeed(3100, 84), ["prefill 3.1k tok/s", "decode 84 tok/s"]);
});

test("formatSpeed omits undefined and zero figures", () => {
  assert.deepEqual(formatSpeed(undefined, undefined), []);
  assert.deepEqual(formatSpeed(3100, undefined), ["prefill 3.1k tok/s"]);
  assert.deepEqual(formatSpeed(0, 84), ["decode 84 tok/s"]);
});
