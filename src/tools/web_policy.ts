import { readFile } from "node:fs/promises";

export type WebAction = "allow" | "ask" | "deny";

export interface WebRule {
  match: string;
  action: WebAction;
}

export interface WebPolicy {
  default: WebAction;
  rules: WebRule[];
  /** Longest URL the model may request. Unset: no limit. */
  maxUrlLength?: number;
  /** Most fetches one user message may trigger. Unset: no limit. */
  maxFetchesPerMessage?: number;
}

export interface Decision {
  action: WebAction;
  rule?: WebRule; // undefined when the default applied
}

const ACTIONS: WebAction[] = ["allow", "ask", "deny"];
const RANK: Record<WebAction, number> = { deny: 3, allow: 2, ask: 1 };

// Lowercases, converts to punycode and drops a trailing dot, the same way for rules and URLs.
function normalizeHost(host: string): string | undefined {
  try {
    return new URL(`http://${host}`).hostname.replace(/\.$/, "");
  } catch {
    return undefined;
  }
}

type Matcher = (url: URL) => boolean;

/** Compiles one rule pattern, or returns an error message saying what is wrong with it. */
function compile(pattern: string): Matcher | string {
  const p = pattern.trim();
  if (p === "") return "is empty";

  // A full URL: same scheme and host (including any port), and a path prefix on segment boundaries.
  if (p.includes("://")) {
    let rule: URL;
    try {
      rule = new URL(p);
    } catch {
      return "is not a valid URL";
    }
    if (rule.protocol !== "http:" && rule.protocol !== "https:") return "must be an http or https URL";
    if (rule.search || rule.hash || rule.username || rule.password) return "may only contain a scheme, host and path";
    const host = rule.host.replace(/\.$/, "");
    const path = rule.pathname;
    return (url) => {
      if (url.protocol !== rule.protocol || url.host.replace(/\.$/, "") !== host) return false;
      if (path === "/" || path.endsWith("/")) return url.pathname.startsWith(path);
      return url.pathname === path || url.pathname.startsWith(`${path}/`);
    };
  }

  if (/[/?#@\s]/.test(p)) return 'must be a host, "*.domain", or a full http(s) URL';

  // "*.example.com": any subdomain, not example.com itself.
  if (p.startsWith("*.")) {
    const domain = normalizeHost(p.slice(2));
    if (!domain || domain.includes("*")) return "has an invalid domain after *.";
    return (url) => url.hostname.replace(/\.$/, "").endsWith(`.${domain}`);
  }

  if (p.includes("*")) return 'may only use * as a leading "*." wildcard';
  if (p.includes(":") && !p.startsWith("[")) return 'includes a port; use a full URL such as "https://host:8443/" to match one';
  const host = normalizeHost(p);
  if (!host) return "is not a valid host name";
  return (url) => url.hostname.replace(/\.$/, "") === host;
}

export interface CompiledPolicy {
  policy: WebPolicy;
  decide(url: URL): Decision;
  /** A short summary for the tool description and the REPL banner. */
  summary(): string;
}

/** Validates parsed JSON. Throws an Error naming the source and the problem; nothing is silently ignored. */
export function compileWebPolicy(json: unknown, source = "web policy"): CompiledPolicy {
  const fail = (msg: string): never => {
    throw new Error(`${source}: ${msg}`);
  };
  if (typeof json !== "object" || json === null || Array.isArray(json)) fail("must be a JSON object");
  const obj = json as Record<string, unknown>;

  const known = new Set(["default", "rules", "maxUrlLength", "maxFetchesPerMessage"]);
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) fail(`unknown setting "${key}" (expected one of: ${[...known].join(", ")})`);
  }

  const def = obj.default ?? "deny";
  if (!ACTIONS.includes(def as WebAction)) fail(`"default" must be one of ${ACTIONS.join(", ")} (got ${JSON.stringify(def)})`);

  if (obj.rules !== undefined && !Array.isArray(obj.rules)) fail('"rules" must be an array');
  const rules: WebRule[] = [];
  const matchers: Matcher[] = [];
  ((obj.rules as unknown[]) ?? []).forEach((r, i) => {
    const where = `rules[${i}]`;
    if (typeof r !== "object" || r === null || Array.isArray(r)) fail(`${where} must be an object with "match" and "action"`);
    const { match, action, ...rest } = r as Record<string, unknown>;
    if (Object.keys(rest).length > 0) fail(`${where} has unknown key(s): ${Object.keys(rest).join(", ")}`);
    if (typeof match !== "string") fail(`${where}.match must be a string`);
    if (!ACTIONS.includes(action as WebAction)) fail(`${where}.action must be one of ${ACTIONS.join(", ")}`);
    const compiled = compile(match as string);
    if (typeof compiled === "string") fail(`${where}.match "${match}" ${compiled}`);
    rules.push({ match: (match as string).trim(), action: action as WebAction });
    matchers.push(compiled as Matcher);
  });

  const limit = (key: "maxUrlLength" | "maxFetchesPerMessage"): number | undefined => {
    const v = obj[key];
    if (v === undefined) return undefined;
    if (!Number.isInteger(v) || (v as number) < 1) fail(`"${key}" must be a whole number of 1 or more`);
    return v as number;
  };

  const policy: WebPolicy = {
    default: def as WebAction,
    rules,
    maxUrlLength: limit("maxUrlLength"),
    maxFetchesPerMessage: limit("maxFetchesPerMessage"),
  };

  return {
    policy,
    // deny beats allow, which beats ask; the default applies only when no rule matches.
    decide(url) {
      let best: Decision | undefined;
      rules.forEach((rule, i) => {
        if (matchers[i]!(url) && (!best || RANK[rule.action] > RANK[best.action])) best = { action: rule.action, rule };
      });
      return best ?? { action: policy.default };
    },
    summary() {
      const list = (a: WebAction) => {
        const items = rules.filter((r) => r.action === a).map((r) => r.match);
        return items.length > 20 ? `${items.slice(0, 20).join(", ")} and ${items.length - 20} more` : items.join(", ");
      };
      const parts = [
        list("allow") && `allowed without asking: ${list("allow")}`,
        list("ask") && `allowed after the user approves: ${list("ask")}`,
        list("deny") && `blocked: ${list("deny")}`,
        `any other site is ${{ allow: "allowed", ask: "allowed after the user approves", deny: "refused" }[policy.default]}`,
      ].filter(Boolean);
      return parts.join("; ");
    },
  };
}

/**
 * Loads a policy file. A missing file returns undefined unless `required` (the path was set
 * explicitly); any other problem throws, so a broken policy never silently turns into no policy.
 */
export async function loadWebPolicy(path: string, required: boolean): Promise<CompiledPolicy | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && !required) return undefined;
    throw new Error(`could not read web policy ${path}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  return compileWebPolicy(json, path);
}
