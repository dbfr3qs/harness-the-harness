import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient, InterruptedError } from "../src/client.ts";
import { createGeminiClient } from "../src/gemini/client.ts";

const cfg = {
  provider: "gemini" as const,
  apiKey: "k",
  baseUrl: "https://x",
  model: "gemini-3.1-pro-preview",
  maxTokens: 100,
  timeoutMs: 1000,
  maxRetries: 0,
  stream: false,
};
const req = { system: "", messages: [{ role: "user" as const, content: "hi" }], tools: [] };
const okBody = {
  candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
};
const json = (b: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), { status, headers });

test("non-stream callModel posts to generateContent and returns a mapped response", async () => {
  let seen: any;
  const fetchMock = async (url: string, init: any) => {
    seen = { url, init };
    return json(okBody);
  };
  const client = createGeminiClient(cfg, {}, { fetch: fetchMock as any });
  const r = await client(req);
  assert.equal(seen.url, "https://x/v1beta/models/gemini-3.1-pro-preview:generateContent");
  assert.equal(seen.init.headers["x-goog-api-key"], "k");
  assert.equal(r.content[0].type === "text" && r.content[0].text, "hi");
  assert.equal(r.usage.input_tokens, 5);
  assert.equal(r.model, "gemini-3.1-pro-preview");
});

test("a 429 is retried and a 400 is fatal", async () => {
  const seq = [json({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "slow" } }, 429, { "retry-after": "2" }), json(okBody)];
  const retries: any[] = [];
  const sleeps: number[] = [];
  const client = createGeminiClient({ ...cfg, maxRetries: 1 }, { onRetry: (i) => retries.push(i) }, {
    fetch: (async () => seq.shift()!) as any,
    sleep: async (ms) => void sleeps.push(ms),
  });
  const r = await client(req);
  assert.equal(r.content[0].type, "text");
  assert.equal(retries.length, 1);
  assert.deepEqual(sleeps, [2000]);

  const bad = createGeminiClient({ ...cfg, maxRetries: 3 }, {}, {
    fetch: (async () => json({ error: { code: 400, status: "INVALID_ARGUMENT", message: "bad field" } }, 400)) as any,
    sleep: async () => {},
  });
  await assert.rejects(bad(req), /INVALID_ARGUMENT: bad field/);
});

test("signal abort rejects with InterruptedError", async () => {
  const ctrl = new AbortController();
  const fetchMock = (_u: string, init: any) =>
    new Promise<Response>((_res, rej) => {
      init.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
      setTimeout(() => ctrl.abort(), 5);
    });
  const client = createGeminiClient(cfg, {}, { fetch: fetchMock as any, sleep: async () => {} });
  await assert.rejects(client({ ...req, signal: ctrl.signal }), InterruptedError);
});

const sse = (...chunks: unknown[]) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join(""), { status: 200 });

test("stream posts to streamGenerateContent and fires hooks", async () => {
  let url = "";
  const events: string[] = [];
  const client = createGeminiClient(
    { ...cfg, stream: true, showThinking: true },
    {
      onRequest: () => events.push("req"),
      onFirstToken: (i) => events.push(`first:${i.inputTokens}`),
      onTextDelta: (t) => events.push(`text:${t}`),
      onThinkingDelta: (t) => events.push(`think:${t}`),
      onStreamDone: (i) => events.push(`done:${i.outputTokens}`),
    },
    {
      fetch: (async (u: string) => {
        url = u;
        return sse(
          { candidates: [{ content: { parts: [{ text: "hmm", thought: true }] } }] },
          { candidates: [{ content: { parts: [{ text: "yo" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 } },
        );
      }) as any,
    },
  );
  const r = await client(req);
  assert.match(url, /:streamGenerateContent\?alt=sse$/);
  assert.deepEqual(events, ["req", "first:0", "think:hmm", "text:yo", "done:3"]);
  assert.equal(r.content.find((b) => b.type === "text")?.type, "text");
});

test("a stream failure after output began is surfaced, not retried", async () => {
  let calls = 0;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "partial" }] } }] })}\n\n`));
    },
    pull(c) {
      c.error(new Error("socket reset"));
    },
  });
  const client = createGeminiClient({ ...cfg, stream: true, maxRetries: 2 }, { onTextDelta: () => {} }, {
    fetch: (async () => (calls++, new Response(body, { status: 200 }))) as any,
    sleep: async () => {},
  });
  await assert.rejects(client(req), /after output began/);
  assert.equal(calls, 1);
});

test("createClient dispatches gemini vs anthropic by provider", async () => {
  const urls: string[] = [];
  const fetchMock = (async (u: string) => {
    urls.push(u);
    return json(u.includes("/v1beta/") ? okBody : { content: [{ type: "text", text: "a" }], usage: { input_tokens: 1, output_tokens: 1 } });
  }) as any;
  await createClient(cfg, {}, { fetch: fetchMock })(req);
  await createClient({ ...cfg, provider: "anthropic", baseUrl: "https://a" }, {}, { fetch: fetchMock })(req);
  assert.match(urls[0], /\/v1beta\/models\//);
  assert.equal(urls[1], "https://a/v1/messages");
});

test("a 400 'API key not valid' is fatal and hints at GEMINI_API_KEY", async () => {
  let calls = 0;
  const client = createGeminiClient({ ...cfg, maxRetries: 3 }, {}, {
    fetch: (async () => (calls++, json({ error: { code: 400, status: "INVALID_ARGUMENT", message: "API key not valid. Please pass a valid API key." } }, 400))) as any,
    sleep: async () => {},
  });
  await assert.rejects(client(req), /GEMINI_API_KEY/);
  assert.equal(calls, 1);
});

test("an in-stream error event after output is surfaced once, cleanly", async () => {
  let calls = 0;
  const client = createGeminiClient({ ...cfg, stream: true, maxRetries: 2 }, { onTextDelta: () => {} }, {
    fetch: (async () => (calls++, sse(
      { candidates: [{ content: { parts: [{ text: "partial" }] } }] },
      { error: { code: 503, status: "UNAVAILABLE", message: "overloaded" } },
    ))) as any,
    sleep: async () => {},
  });
  await assert.rejects(client(req), (e: Error) => {
    assert.match(e.message, /after output began/);
    assert.doesNotMatch(e.message, /network error/);
    assert.equal(e.message.match(/after output began/g)!.length, 1);
    return true;
  });
  assert.equal(calls, 1);
});
