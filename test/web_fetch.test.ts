import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { createRegistry } from "../src/registry.ts";
import { createWebFetchTool, decodeEntities, htmlToText, isPublicAddress } from "../src/tools/web_fetch.ts";

// --- a local server ------------------------------------------------------------

let server: Server;
let base: string;
const hits: string[] = [];

const PAGE = `<!doctype html><html><head><title>Test &amp; Page</title>
<style>body { color: red }</style><script>alert("x")</script></head>
<body><nav><a href="/">Home</a></nav>
<h1>Main heading</h1>
<p>Hello&nbsp;world &mdash; caf&#233; &#x1F600;.</p>
<ul><li>First <b>item</b></li><li>Second</li></ul>
<p>See <a href="/docs/intro?x=1&amp;y=2">the intro</a> and <a href="#top">top</a>.</p>
<!-- hidden comment -->
</body></html>`;

before(async () => {
  server = createServer((req, res) => {
    hits.push(req.url ?? "");
    const send = (status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": type, ...headers });
      res.end(body);
    };
    switch (req.url) {
      case "/page": return send(200, "text/html; charset=utf-8", PAGE);
      case "/json": return send(200, "application/json", '{"ok":true}');
      case "/image": return send(200, "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      case "/missing": return send(404, "text/plain", "no such page");
      case "/redirect": return send(302, "text/plain", "", { location: "/page" });
      case "/redirect-private": return send(302, "text/plain", "", { location: "http://10.0.0.1/secret" });
      case "/redirect-scheme": return send(302, "text/plain", "", { location: "file:///etc/passwd" });
      case "/loop": return send(302, "text/plain", "", { location: "/loop" });
      case "/long": return send(200, "text/plain", "abcdefghij".repeat(30));
      case "/huge": return send(200, "text/plain", "x".repeat(5000));
      case "/gzip": return send(200, "text/plain", gzipSync("compressed text"), { "content-encoding": "gzip" });
      case "/latin1": return send(200, "text/plain; charset=iso-8859-1", Buffer.from([0x63, 0x61, 0x66, 0xe9]));
      case "/slow": return; // never responds
      default: return send(404, "text/plain", "");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

function tool(opts: Partial<Parameters<typeof createWebFetchTool>[0]> = {}) {
  const asked: string[] = [];
  const registry = createRegistry([
    createWebFetchTool({
      confirm: async (url) => {
        asked.push(url.href);
        return true;
      },
      pageChars: 100,
      allowAddress: (ip) => ip === "127.0.0.1", // the local test server only
      ...opts,
    }),
  ]);
  return { fetch: (input: Record<string, unknown>) => registry.dispatch("web_fetch", input), asked };
}

// --- address checks --------------------------------------------------------------

test("isPublicAddress allows public addresses and refuses private, local and reserved ones", () => {
  for (const ip of ["93.184.215.14", "8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"]) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
  for (const ip of [
    "127.0.0.1", "127.255.0.9", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::", "::1", "fe80::1", "fc00::1", "fd12:3456::1",
    "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "::127.0.0.1",
    "not-an-ip", "",
  ]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  assert.equal(isPublicAddress("172.32.0.1"), true, "just outside 172.16/12");
});

test("by default, local and private addresses are refused without connecting or asking", async () => {
  const { fetch, asked } = tool({ allowAddress: undefined });
  const before = hits.length;
  for (const url of [
    `${base}/page`, "http://localhost:1/", "http://[::1]:1/", "http://169.254.169.254/latest/meta-data/",
    "http://[::ffff:127.0.0.1]:1/", "http://10.0.0.1/", "http://0x7f.1/",
  ]) {
    const out = await fetch({ url });
    assert.equal(out.isError, true, url);
    assert.match(out.content, /private or local address/, url);
  }
  assert.equal(hits.length, before, "no request reached the server");
  assert.deepEqual(asked.filter((u) => !u.includes("localhost")), [], "IP literals are refused before asking");
});

test("bad URLs, other schemes and credentials are refused before asking", async () => {
  const { fetch, asked } = tool();
  const cases: [string, RegExp][] = [
    ["not a url", /not a valid absolute URL/],
    ["file:///etc/passwd", /only http and https/],
    ["ftp://example.com/x", /only http and https/],
    ["https://user:pass@example.com/", /credentials/],
  ];
  for (const [url, pattern] of cases) {
    const out = await fetch({ url });
    assert.equal(out.isError, true, url);
    assert.match(out.content, pattern, url);
  }
  assert.deepEqual(asked, []);
});

// --- approval ------------------------------------------------------------------------

test("a declined fetch never reaches the server and tells the model not to retry", async () => {
  const before = hits.length;
  const { fetch } = tool({ confirm: async () => false });
  const out = await fetch({ url: `${base}/page` });
  assert.equal(out.isError, true);
  assert.match(out.content, /user declined to fetch .* Do not retry/);
  assert.equal(hits.length, before);
});

test("approval is asked once per fetch, for the URL the model chose, not for redirect hops", async () => {
  const { fetch, asked } = tool();
  const out = await fetch({ url: `${base}/redirect` });
  assert.equal(out.isError, false);
  assert.match(out.content, new RegExp(`^URL: ${base}/page`));
  assert.deepEqual(asked, [`${base}/redirect`]);
});

// --- content ---------------------------------------------------------------------------

test("HTML becomes readable text with title, headings, list items and absolute links", async () => {
  const { fetch } = tool({ pageChars: 10_000 });
  const out = await fetch({ url: `${base}/page` });
  assert.equal(out.isError, false);
  assert.match(out.content, /^URL: http:\/\/127\.0\.0\.1:\d+\/page\nStatus: 200 OK\nTitle: Test & Page\nShowing characters 0-\d+ of \d+\./);
  const body = out.content.split("\n\n").slice(1).join("\n\n");
  assert.equal(
    body,
    [
      `Home (${base}/)`,
      "",
      "# Main heading",
      "",
      "Hello world — café 😀.",
      "",
      "- First item",
      "- Second",
      "",
      `See the intro (${base}/docs/intro?x=1&y=2) and top.`,
    ].join("\n"),
  );
  assert.doesNotMatch(out.content, /alert|color: red|hidden comment/);
});

test("JSON, gzip and declared charsets are returned as text", async () => {
  const { fetch } = tool();
  assert.match((await fetch({ url: `${base}/json` })).content, /\n\n\{"ok":true\}$/);
  assert.match((await fetch({ url: `${base}/gzip` })).content, /\n\ncompressed text$/);
  assert.match((await fetch({ url: `${base}/latin1` })).content, /\n\ncafé$/);
});

test("binary content is refused", async () => {
  const out = await tool().fetch({ url: `${base}/image` });
  assert.equal(out.isError, true);
  assert.match(out.content, /returned image\/png content, which is not text/);
});

test("HTTP errors become error results with the status", async () => {
  const out = await tool().fetch({ url: `${base}/missing` });
  assert.equal(out.isError, true);
  assert.match(out.content, /returned HTTP 404 Not Found\.\nno such page/);
});

test("long text is paged with offset", async () => {
  const { fetch } = tool();
  const first = await fetch({ url: `${base}/long` });
  assert.match(first.content, /Showing characters 0-100 of 300\./);
  assert.match(first.content, /\[more: 200 chars remain; call web_fetch again with offset=100\]$/);
  const last = await fetch({ url: `${base}/long`, offset: 200 });
  assert.match(last.content, /Showing characters 200-300 of 300\./);
  assert.doesNotMatch(last.content, /\[more:/);
  const past = await fetch({ url: `${base}/long`, offset: 999 });
  assert.equal(past.isError, true);
  assert.match(past.content, /past the end/);
});

test("downloads stop at the size cap and say so", async () => {
  const out = await tool({ maxBytes: 1000, pageChars: 10_000 }).fetch({ url: `${base}/huge` });
  assert.equal(out.isError, false);
  assert.match(out.content, /Showing characters 0-1000 of 1000\.\nNote: the download stopped at/);
});

// --- redirects and timeouts -------------------------------------------------------------

test("redirects to private addresses or other schemes are refused", async () => {
  const { fetch } = tool();
  const priv = await fetch({ url: `${base}/redirect-private` });
  assert.equal(priv.isError, true);
  assert.match(priv.content, /a redirect points to 10\.0\.0\.1, a private or local address/);
  const scheme = await fetch({ url: `${base}/redirect-scheme` });
  assert.match(scheme.content, /a redirect uses file; only http and https/);
});

test("redirect loops give up", async () => {
  const out = await tool().fetch({ url: `${base}/loop` });
  assert.equal(out.isError, true);
  assert.match(out.content, /redirected more than 5 times/);
});

test("a server that never answers times out", async () => {
  const out = await tool({ timeoutMs: 200 }).fetch({ url: `${base}/slow` });
  assert.equal(out.isError, true);
  assert.match(out.content, /timed out after 0\.2 s/);
});

// --- helpers --------------------------------------------------------------------------------

test("decodeEntities handles named, decimal and hex entities and leaves unknown ones", () => {
  assert.equal(decodeEntities("&lt;a&gt; &amp;amp; &#65;&#x42; &unknown; &#0;"), "<a> &amp; AB &unknown; &#0;");
});

test("htmlToText drops javascript: and mailto: links but keeps their text", () => {
  const { text } = htmlToText('<a href="javascript:void(0)">Click</a> <a href="mailto:a@b.c">Mail</a>', new URL("https://x.test/"));
  assert.equal(text, "Click Mail");
});
