import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileWebPolicy, loadWebPolicy } from "../src/tools/web_policy.ts";

const policy = compileWebPolicy({
  default: "deny",
  rules: [
    { match: "docs.example.com", action: "allow" },
    { match: "*.wiki.test", action: "allow" },
    { match: "https://github.com/anthropics/", action: "allow" },
    { match: "https://api.example.com:8443/v1", action: "allow" },
    { match: "github.com", action: "ask" },
    { match: "evil.wiki.test", action: "deny" },
  ],
});
const act = (url: string) => policy.decide(new URL(url)).action;

test("bare hosts match exactly, after normalising case, punycode and a trailing dot", () => {
  assert.equal(act("https://docs.example.com/page"), "allow");
  assert.equal(act("https://DOCS.Example.COM./x"), "allow");
  assert.equal(act("https://docs.example.com:444/x"), "allow", "host rules match any port");
  assert.equal(act("https://sub.docs.example.com/"), "deny", "subdomains need a wildcard");
  assert.equal(act("https://docs.example.com.evil.test/"), "deny");
  assert.equal(act("https://example.com/"), "deny");
});

test("*.domain matches subdomains only, and deny beats allow", () => {
  assert.equal(act("https://en.wiki.test/"), "allow");
  assert.equal(act("https://a.b.wiki.test/"), "allow");
  assert.equal(act("https://wiki.test/"), "deny", "the bare domain is not included");
  assert.equal(act("https://notwiki.test/"), "deny");
  assert.equal(act("https://evil.wiki.test/"), "deny", "deny rule wins over the wildcard allow");
});

test("URL rules match scheme, host, port and a path prefix on segment boundaries", () => {
  assert.equal(act("https://github.com/anthropics/"), "allow");
  assert.equal(act("https://github.com/anthropics/sdk/blob/main/README.md"), "allow");
  assert.equal(act("https://github.com/anthropics"), "ask", "no trailing slash: falls back to the github.com ask rule");
  assert.equal(act("https://github.com/anthropics-evil/x"), "ask");
  assert.equal(act("http://github.com/anthropics/"), "ask", "scheme must match");
  assert.equal(act("https://api.example.com:8443/v1"), "allow");
  assert.equal(act("https://api.example.com:8443/v1/models?x=1"), "allow");
  assert.equal(act("https://api.example.com:8443/v10"), "deny", "/v1 does not match /v10");
  assert.equal(act("https://api.example.com/v1"), "deny", "port must match");
});

test("allow beats ask, and the default applies only when nothing matches", () => {
  assert.equal(act("https://github.com/someone/else"), "ask");
  const d = policy.decide(new URL("https://github.com/anthropics/x"));
  assert.deepEqual(d, { action: "allow", rule: { match: "https://github.com/anthropics/", action: "allow" } });
  assert.deepEqual(policy.decide(new URL("https://nowhere.test/")), { action: "deny" });
  assert.equal(compileWebPolicy({ default: "ask" }).decide(new URL("https://x.test/")).action, "ask");
});

test("default is deny when omitted, and the limits are unset unless given", () => {
  const p = compileWebPolicy({ rules: [] }).policy;
  assert.equal(p.default, "deny");
  assert.equal(p.maxUrlLength, undefined);
  assert.equal(p.maxFetchesPerMessage, undefined);
  const limited = compileWebPolicy({ maxUrlLength: 300, maxFetchesPerMessage: 5 }).policy;
  assert.equal(limited.maxUrlLength, 300);
  assert.equal(limited.maxFetchesPerMessage, 5);
});

test("invalid policies are rejected with a message naming the problem", () => {
  const cases: [unknown, RegExp][] = [
    [[], /must be a JSON object/],
    [{ default: "maybe" }, /"default" must be one of allow, ask, deny/],
    [{ rules: {} }, /"rules" must be an array/],
    [{ rules: [{ match: "a.test" }] }, /rules\[0\]\.action must be one of/],
    [{ rules: [{ match: 5, action: "allow" }] }, /rules\[0\]\.match must be a string/],
    [{ rules: [{ match: "a.test", action: "allow", note: "x" }] }, /rules\[0\] has unknown key\(s\): note/],
    [{ rules: [{ match: "", action: "allow" }] }, /is empty/],
    [{ rules: [{ match: "a.test/path", action: "allow" }] }, /must be a host, "\*\.domain", or a full http\(s\) URL/],
    [{ rules: [{ match: "a.*.test", action: "allow" }] }, /only use \* as a leading/],
    [{ rules: [{ match: "*", action: "allow" }] }, /only use \* as a leading/],
    [{ rules: [{ match: "a.test:8080", action: "allow" }] }, /includes a port/],
    [{ rules: [{ match: "ftp://a.test/", action: "allow" }] }, /must be an http or https URL/],
    [{ rules: [{ match: "https://a.test/?q=1", action: "allow" }] }, /only contain a scheme, host and path/],
    [{ maxUrlLength: 0 }, /"maxUrlLength" must be a whole number of 1 or more/],
    [{ maxFetchesPerMessage: 2.5 }, /"maxFetchesPerMessage" must be a whole number/],
    [{ allowlist: [] }, /unknown setting "allowlist"/],
  ];
  for (const [json, pattern] of cases) {
    assert.throws(() => compileWebPolicy(json, "test.json"), (err: Error) => {
      assert.match(err.message, /^test\.json: /);
      assert.match(err.message, pattern);
      return true;
    }, JSON.stringify(json));
  }
});

test("summary lists the rules by action and states the default", () => {
  assert.equal(
    policy.summary(),
    "allowed without asking: docs.example.com, *.wiki.test, https://github.com/anthropics/, https://api.example.com:8443/v1; " +
      "allowed after the user approves: github.com; blocked: evil.wiki.test; any other site is refused",
  );
});

// --- loading ------------------------------------------------------------------

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-policy-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("a missing file is no policy unless the path was set explicitly", async () => {
  assert.equal(await loadWebPolicy(join(dir, "nope.json"), false), undefined);
  await assert.rejects(loadWebPolicy(join(dir, "nope.json"), true), /could not read web policy/);
});

test("broken JSON and invalid content are errors, never silently ignored", async () => {
  await writeFile(join(dir, "bad.json"), "{ not json");
  await assert.rejects(loadWebPolicy(join(dir, "bad.json"), false), /bad\.json is not valid JSON/);
  await writeFile(join(dir, "invalid.json"), '{"default":"sometimes"}');
  await assert.rejects(loadWebPolicy(join(dir, "invalid.json"), false), /invalid\.json: "default" must be one of/);
});

test("the shipped example policy is valid", async () => {
  const loaded = await loadWebPolicy(new URL("../web-policy.example.json", import.meta.url).pathname, true);
  assert.equal(loaded?.policy.default, "deny");
  assert.equal(loaded?.policy.maxUrlLength, undefined);
  assert.equal(loaded?.policy.maxFetchesPerMessage, undefined);
});
