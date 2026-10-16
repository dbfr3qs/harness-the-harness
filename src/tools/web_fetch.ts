import { lookup as dnsLookup } from "node:dns";
import type { LookupAddress } from "node:dns";
import { request as httpRequest } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { defineTool } from "../registry.ts";
import type { CompiledPolicy, Decision } from "./web_policy.ts";

export const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

// --- address checks ----------------------------------------------------------

// Loopback, private, link-local (incl. cloud metadata at 169.254.169.254), CGNAT,
// multicast and reserved ranges. Only public unicast addresses may be fetched.
const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8], ["2001:db8::", 32],
] as const) blocked.addSubnet(net, prefix, "ipv6");

// Expands an IPv6 address to 8 numeric groups (handles "::" and a dotted IPv4 tail).
function ipv6Groups(address: string): number[] | undefined {
  let addr = address.toLowerCase().split("%")[0]!;
  const dotted = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const parts = dotted[1]!.split(".").map(Number);
    addr = addr.slice(0, -dotted[1]!.length) +
      `${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
  }
  const [head, tail] = addr.includes("::") ? addr.split("::") : [addr, undefined];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const fill = tail === undefined ? [] : Array(8 - h.length - t.length).fill("0");
  const groups = [...h, ...fill, ...t].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : undefined;
}

/** True only for public unicast addresses. IPv4 embedded in IPv6 is checked as IPv4. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family !== 6) return false;
  const g = ipv6Groups(address);
  if (!g) return false;
  // ::ffff:a.b.c.d (mapped), 64:ff9b::a.b.c.d (NAT64) and ::a.b.c.d (compatible) carry an IPv4 address.
  const mapped = g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff;
  const nat64 = g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0);
  const compat = g.slice(0, 6).every((x) => x === 0) && (g[6]! !== 0 || g[7]! > 1);
  if (mapped || nat64 || compat) {
    return isPublicAddress(`${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`);
  }
  return !blocked.check(address, "ipv6");
}

// A DNS lookup that refuses non-public results. The socket connects to the address this
// returns, so the address that was checked is the one used (no DNS-rebinding window).
function guardedLookup(allow: (ip: string) => boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
      if (err) return callback(err, "", 4);
      const refused = addresses.find((a) => !allow(a.address));
      if (refused || addresses.length === 0) {
        const e = new Error(`${hostname} resolves to ${refused?.address ?? "no address"}, a private or local address`);
        (e as NodeJS.ErrnoException).code = "EBLOCKEDADDRESS";
        return callback(e, "", 4);
      }
      if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
      callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

// --- HTTP --------------------------------------------------------------------

interface RawResponse {
  url: URL;
  status: number;
  statusText: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
  cut: boolean; // stopped at MAX_DOWNLOAD_BYTES
}

function getOnce(url: URL, lookup: LookupFunction, signal: AbortSignal, maxBytes: number): Promise<RawResponse> {
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        lookup,
        signal,
        headers: {
          "user-agent": "harness/0.1 (web_fetch tool)",
          accept: "text/html, text/plain, application/json, application/xml;q=0.9, */*;q=0.1",
          "accept-encoding": "identity",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let cut = false;
        res.on("data", (chunk: Buffer) => {
          if (cut) return;
          chunks.push(chunk);
          size += chunk.length;
          if (size > maxBytes) {
            cut = true;
            res.destroy();
            done();
          }
        });
        res.on("end", () => done());
        res.on("error", (err) => (cut ? done() : reject(err)));
        res.on("close", () => {
          if (!settled && !res.complete) {
            settled = true;
            reject(new Error("the connection closed before the response finished"));
          }
        });
        let settled = false;
        function done() {
          if (settled) return;
          settled = true;
          resolve({
            url,
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? "",
            headers: res.headers,
            body: Buffer.concat(chunks).subarray(0, maxBytes),
            cut,
          });
        }
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function decompress(res: RawResponse, maxBytes: number): Buffer {
  const encoding = String(res.headers["content-encoding"] ?? "identity").toLowerCase();
  const opts = { maxOutputLength: maxBytes };
  try {
    if (encoding === "gzip" || encoding === "x-gzip") return gunzipSync(res.body, opts);
    if (encoding === "br") return brotliDecompressSync(res.body, opts);
    if (encoding === "deflate") return inflateSync(res.body, opts);
  } catch {
    throw new Error(`the response from ${res.url.host} used ${encoding} compression that could not be decoded.`);
  }
  return res.body;
}

// --- HTML to text ------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…",
  copy: "©", reg: "®", trade: "™", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

const BLOCK_TAGS =
  "p|div|section|article|header|footer|nav|main|aside|ul|ol|table|tr|blockquote|pre|hr|dl|dt|dd|form|figure|figcaption|details|summary";

/** Converts HTML to readable plain text, keeping headings, list items and links (as absolute URLs). */
export function htmlToText(html: string, base: URL): { title: string; text: string } {
  const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim();
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|template|iframe|head|object|canvas)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<a\b[^>]*?\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi,
      (_m, _q, d: string | undefined, sq: string | undefined, bare: string | undefined, inner: string) => {
        const label = inner.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
        const href = decodeEntities(d ?? sq ?? bare ?? "").trim();
        if (!href || href.startsWith("#") || /^(javascript|mailto|tel|data):/i.test(href)) return label;
        let abs: string;
        try {
          abs = new URL(href, base).href;
        } catch {
          return label;
        }
        return label && label !== abs ? `${label} (${abs})` : abs;
      })
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, level: string) => `\n\n${"#".repeat(Number(level))} `)
    .replace(/<\/h[1-6]\s*>/gi, "\n\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(new RegExp(`</?(${BLOCK_TAGS})\\b[^>]*>`, "gi"), "\n")
    .replace(/<\/?(td|th)\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, "");
  s = decodeEntities(s)
    .replace(/\r/g, "")
    .replace(/[ \t\f\v ]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text: s };
}

// --- the tool ------------------------------------------------------------------

const TEXT_TYPES = /^(text\/|application\/(json|xml|xhtml\+xml|javascript|ld\+json|rss\+xml|atom\+xml)|application\/[\w.-]+\+(json|xml))/i;

export interface WebFetchOptions {
  /** Asks the user to approve fetching `url`. Resolves false to decline. */
  confirm: (url: URL, signal: AbortSignal) => Promise<boolean>;
  /** Characters of page text returned per call; longer pages are paged with `offset`. */
  pageChars: number;
  timeoutMs?: number;
  maxBytes?: number;
  /** Which resolved addresses may be connected to. Tests override this to reach a local server. */
  allowAddress?: (ip: string) => boolean;
  /** Site policy, or a function returning the policy in effect now. Without one, every fetch goes to `confirm`. */
  policy?: CompiledPolicy | (() => CompiledPolicy | undefined);
  /** Called with each policy decision, for the transcript. */
  onDecision?: (info: { url: string; stage: "request" | "redirect"; decision: Decision }) => void;
}

// A policy that asks about everything and sets no limits behaves exactly like no policy.
function isTrivial(p: CompiledPolicy): boolean {
  const { policy } = p;
  return policy.default === "ask" && policy.rules.length === 0 &&
    policy.maxUrlLength === undefined && policy.maxFetchesPerMessage === undefined;
}

export function createWebFetchTool(opts: WebFetchOptions) {
  const currentPolicy = (): CompiledPolicy | undefined => {
    const p = typeof opts.policy === "function" ? opts.policy() : opts.policy;
    return p && !isTrivial(p) ? p : undefined;
  };
  let fetchesThisMessage = 0;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_DOWNLOAD_BYTES;
  const allow = opts.allowAddress ?? isPublicAddress;
  const lookup = guardedLookup(allow);

  function checkUrl(url: URL, label: string): void {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`${label} uses ${url.protocol.replace(/:$/, "")}; only http and https URLs can be fetched.`);
    }
    if (url.username || url.password) throw new Error(`${label} contains credentials; URLs with a user name or password are not allowed.`);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && !allow(host)) {
      throw new Error(`${label} points to ${host}, a private or local address. Only public internet addresses can be fetched.`);
    }
  }

  function decide(policy: CompiledPolicy, url: URL, stage: "request" | "redirect"): Decision {
    const decision = policy.decide(url);
    opts.onDecision?.({ url: url.href, stage, decision });
    return decision;
  }

  const refusedBy = (d: Decision, url: URL) =>
    d.rule
      ? `${url.host} is blocked by the web policy (rule "${d.rule.match}")`
      : `${url.host} is not on the web policy's list of allowed sites`;

  // The description includes the policy, but it is only rebuilt by refreshDescription() (at
  // startup and on /reset). Changing tool definitions mid-conversation would rewrite the start of
  // the prompt, so the REPL tells the model about policy changes in a message instead.
  const describe = (): string => {
    const policy = currentPolicy();
    const access = policy
      ? `Site access is limited by policy: ${policy.summary()}. A refused or declined fetch must not be retried.`
      : "The user must approve each fetch (a declined fetch must not be retried).";
    return "Fetch a web page or other text resource over http(s) and return its readable text. Use it when the user asks about the content at a URL " +
      "or you need current information from a specific page. HTML is converted to plain text with links shown as \"text (url)\"; " +
      "long pages are returned in parts, so call again with the offset given at the end to read more. " +
      `${access} Private and local network addresses, binary content ` +
      `and downloads over ${Math.round(maxBytes / 1024 / 1024)} MB are refused.`;
  };

  const tool = defineTool({
    name: "web_fetch",
    description: describe(),
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http or https URL to fetch" },
        offset: { type: "integer", description: "Character offset into the page text to start from. Defaults to 0." },
      },
      required: ["url"],
    },
    handler: async (input, { signal: interrupt }) => {
      const offset = (input.offset as number | undefined) ?? 0;
      if (offset < 0) throw new Error(`offset must be 0 or more (got ${offset}).`);
      let url: URL;
      try {
        url = new URL(input.url as string);
      } catch {
        throw new Error(`"${input.url}" is not a valid absolute URL. Include the scheme, e.g. https://example.com/page.`);
      }
      checkUrl(url, "the URL");

      const policy = currentPolicy(); // read once, so one fetch sees one policy throughout
      let action: Decision["action"] = "ask";
      if (policy) {
        const max = policy.policy.maxUrlLength;
        if (max !== undefined && url.href.length > max) {
          throw new Error(`the URL is ${url.href.length} characters; the web policy allows at most ${max}. Use a shorter URL without long query strings.`);
        }
        const decision = decide(policy, url, "request");
        if (decision.action === "deny") {
          throw new Error(`${refusedBy(decision, url)}. ${policy.summary()}. Do not retry; tell the user if you need a different site.`);
        }
        action = decision.action;

        const budget = policy.policy.maxFetchesPerMessage;
        if (budget !== undefined && fetchesThisMessage >= budget) {
          throw new Error(`this message has already used its ${budget} web fetch(es) allowed by the web policy. Do not fetch more; answer with what you have, or tell the user.`);
        }
      }

      if (action === "ask" && !(await opts.confirm(url, interrupt))) {
        if (interrupt.aborted) throw new Error(`fetching ${url.href} was interrupted by the user.`);
        throw new Error(`the user declined to fetch ${url.href}. Do not retry this URL; ask the user how they would like to proceed.`);
      }
      fetchesThisMessage++;
      const approvedHost = url.host;

      const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), interrupt]);
      let res: RawResponse | undefined;
      for (let hops = 0; ; hops++) {
        try {
          res = await getOnce(url, lookup, signal, maxBytes);
        } catch (err) {
          const e = err as NodeJS.ErrnoException;
          if (e.code === "EBLOCKEDADDRESS") throw new Error(`${e.message}. Only public internet addresses can be fetched.`);
          if (interrupt.aborted) throw new Error(`fetching ${url.href} was interrupted by the user.`);
          if (e.name === "TimeoutError" || e.name === "AbortError") throw new Error(`fetching ${url.href} timed out after ${timeoutMs / 1000} s.`);
          throw new Error(`could not fetch ${url.href}: ${e.code ? `${e.code} ` : ""}${e.message}`);
        }
        const location = res.headers.location;
        if (res.status < 300 || res.status >= 400 || !location) break;
        if (hops >= MAX_REDIRECTS) throw new Error(`${input.url} redirected more than ${MAX_REDIRECTS} times; giving up.`);
        try {
          url = new URL(location, url);
        } catch {
          throw new Error(`${url.href} redirected to an invalid URL: ${location}`);
        }
        checkUrl(url, "a redirect");
        // Re-check the policy on every hop, or an open redirect on an allowed site would bypass it.
        // A redirect may stay on the host that was just approved; anywhere else must be "allow".
        if (policy) {
          const decision = decide(policy, url, "redirect");
          const why =
            decision.action === "deny"
              ? refusedBy(decision, url)
              : decision.action === "ask" && url.host !== approvedHost
                ? `${url.host} needs the user's approval, which is not asked for in the middle of a redirect`
                : undefined;
          if (why) {
            throw new Error(`${input.url} redirected to ${url.href}, but ${why}. Do not retry; tell the user where it redirected.`);
          }
        }
      }

      const contentType = String(res.headers["content-type"] ?? "text/plain");
      const mime = contentType.split(";")[0]!.trim().toLowerCase();
      if (!TEXT_TYPES.test(mime)) {
        throw new Error(`${res.url.href} returned ${mime} content, which is not text. web_fetch only reads text, HTML, JSON and XML.`);
      }
      const charset = contentType.match(/charset\s*=\s*"?([\w.:-]+)/i)?.[1] ?? "utf-8";
      let raw: string;
      try {
        raw = new TextDecoder(charset).decode(decompress(res, maxBytes));
      } catch (err) {
        if (err instanceof RangeError) raw = new TextDecoder("utf-8").decode(decompress(res, maxBytes));
        else throw err;
      }

      const isHtml = mime === "text/html" || mime === "application/xhtml+xml";
      const { title, text } = isHtml ? htmlToText(raw, res.url) : { title: "", text: raw.trim() };

      if (res.status >= 400) {
        const snippet = text.slice(0, 500);
        throw new Error(`${res.url.href} returned HTTP ${res.status} ${res.statusText}.${snippet ? `\n${snippet}` : ""}`);
      }

      if (offset > 0 && offset >= text.length) {
        throw new Error(`offset ${offset} is past the end of the page text (${text.length} chars).`);
      }
      const end = Math.min(text.length, offset + opts.pageChars);
      const header = [
        `URL: ${res.url.href}`,
        `Status: ${res.status} ${res.statusText}`.trim(),
        ...(title ? [`Title: ${title}`] : []),
        text.length === 0 ? "The page has no text content." : `Showing characters ${offset}-${end} of ${text.length}.`,
        ...(res.cut ? [`Note: the download stopped at ${Math.round(maxBytes / 1024 / 1024)} MB, so the page text is incomplete.`] : []),
      ].join("\n");
      const more = end < text.length
        ? `\n\n[more: ${text.length - end} chars remain; call web_fetch again with offset=${end}]`
        : "";
      return `${header}\n\n${text.slice(offset, end)}${more}`;
    },
  });

  return Object.assign(tool, {
    /** Called before each user message: resets the maxFetchesPerMessage count. */
    newMessage() {
      fetchesThisMessage = 0;
    },
    /** Rebuilds the description from the policy in effect now. Call only when history is empty. */
    refreshDescription() {
      tool.description = describe();
    },
  });
}
