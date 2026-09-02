import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRules, ruleId, PRIORITY, ID_MIN, ID_SPAN } from "../src/lib/rules.js";

const NOW = 1_800_000_000_000;
const BLOCK = "chrome-extension://abc/src/block/block.html";
const list = (patterns, extra = {}) => ({
  id: "default",
  name: "Not today",
  mode: "wall",
  enabled: true,
  patterns,
  ...extra,
});
const state = (extra = {}) => ({ now: NOW, blockPageUrl: BLOCK, ...extra });

test("one rule per pattern, main_frame only, redirecting to the block page", () => {
  const rules = buildRules([list(["reddit.com", "discord.com"])], state());
  assert.equal(rules.length, 2);
  for (const r of rules) {
    assert.equal(r.action.type, "redirect");
    assert.deepEqual(r.condition.resourceTypes, ["main_frame"]);
    assert.equal(r.condition.regexFilter, "^(.*)$");
    assert.ok(r.action.redirect.regexSubstitution.startsWith(BLOCK + "?reason=list&h="));
    assert.ok(r.action.redirect.regexSubstitution.endsWith("&u=\\1"), "u= must be last");
    assert.equal(r.priority, PRIORITY.LIST);
  }
  assert.deepEqual(
    rules.map((r) => r.condition.requestDomains[0]).sort(),
    ["discord.com", "reddit.com"],
  );
});

test("patterns are normalized and deduped across lists", () => {
  const rules = buildRules(
    [list(["WWW.Reddit.com", "reddit.com."]), list(["reddit.com"], { id: "b" })],
    state(),
  );
  assert.equal(rules.length, 1);
  assert.equal(rules[0].condition.requestDomains[0], "reddit.com");
});

test("one rule per watched domain with reason=loop in the target", () => {
  const rules = buildRules([list([])], state({ watched: [{ domain: "reddit.com" }] }));
  assert.equal(rules.length, 1);
  assert.match(rules[0].action.redirect.regexSubstitution, /\?reason=loop&d=reddit\.com&u=\\1$/);
  assert.equal(rules[0].priority, PRIORITY.LOOP);
});

test("a watched domain that is also listed gets the list rule only", () => {
  const rules = buildRules([list(["reddit.com"])], state({ watched: [{ domain: "reddit.com" }] }));
  assert.equal(rules.length, 1);
  assert.match(rules[0].action.redirect.regexSubstitution, /reason=list/);
});

test("stable ids across two calls", () => {
  const lists = [list(["reddit.com", "discord.com", "facebook.com"])];
  const st = state({ watched: [{ domain: "news.ycombinator.com" }], passes: [{ host: "reddit.com", until: NOW + 1 }] });
  const a = buildRules(lists, st);
  const b = buildRules(lists, st);
  assert.deepEqual(a, b);
  for (const r of a) {
    assert.ok(r.id >= ID_MIN && r.id < ID_MIN + ID_SPAN + 1, `id in range: ${r.id}`);
  }
  assert.equal(new Set(a.map((r) => r.id)).size, a.length, "ids unique");
  assert.equal(ruleId("list", "reddit.com"), ruleId("list", "reddit.com"));
  assert.notEqual(ruleId("list", "reddit.com"), ruleId("loop", "reddit.com"));
});

test("pass produces a higher-priority allow rule", () => {
  const rules = buildRules([list(["reddit.com"])], state({ passes: [{ host: "reddit.com", until: NOW + 60_000 }] }));
  const allow = rules.find((r) => r.action.type === "allow");
  const redirect = rules.find((r) => r.action.type === "redirect");
  assert.ok(allow);
  assert.ok(redirect);
  assert.ok(allow.priority > redirect.priority);
  assert.deepEqual(allow.condition.requestDomains, ["reddit.com"]);
  assert.deepEqual(allow.condition.resourceTypes, ["main_frame"]);
});

test("expired passes and expired walls produce nothing", () => {
  const rules = buildRules(
    [list([])],
    state({ passes: [{ host: "reddit.com", until: NOW - 1 }], walled: [{ domain: "x.com", until: NOW }] }),
  );
  assert.equal(rules.length, 0);
});

test("disabled list yields no rules", () => {
  assert.deepEqual(buildRules([list(["reddit.com"], { enabled: false })], state()), []);
});

test("wall list with no session yields the same redirect (mode decided by the page)", () => {
  const noSession = buildRules([list(["reddit.com"], { mode: "wall" })], state());
  const friction = buildRules([list(["reddit.com"], { mode: "friction" })], state());
  assert.deepEqual(noSession, friction);
  assert.equal(noSession[0].action.type, "redirect");
});

test("walled (Not today) domains redirect with reason=list", () => {
  const rules = buildRules([list([])], state({ walled: [{ domain: "reddit.com", until: NOW + 1 }] }));
  assert.equal(rules.length, 1);
  assert.match(rules[0].action.redirect.regexSubstitution, /reason=list&h=reddit\.com/);
});

test("domain-scoped ignore suppresses a watched domain's rule", () => {
  const rules = buildRules(
    [list([])],
    state({
      watched: [{ domain: "atlassian.net" }],
      ignored: [{ match: "atlassian.net", scope: "domain", until: NOW + 1 }],
    }),
  );
  assert.deepEqual(rules, []);
});

test("host-scoped ignore adds an allow that beats loop rules but not list rules", () => {
  const rules = buildRules(
    [list([])],
    state({
      watched: [{ domain: "reddit.com" }],
      ignored: [{ match: "ads.reddit.com", scope: "host", until: NOW + 1 }],
    }),
  );
  const allow = rules.find((r) => r.action.type === "allow");
  const loop = rules.find((r) => r.action.type === "redirect");
  assert.ok(allow && loop);
  assert.deepEqual(allow.condition.requestDomains, ["ads.reddit.com"]);
  assert.ok(allow.priority > loop.priority);
  assert.ok(allow.priority < PRIORITY.LIST);
});

test("expired ignore does not suppress", () => {
  const rules = buildRules(
    [list([])],
    state({
      watched: [{ domain: "atlassian.net" }],
      ignored: [{ match: "atlassian.net", scope: "domain", until: NOW - 1 }],
    }),
  );
  assert.equal(rules.length, 1);
});

test("junk patterns are skipped", () => {
  const rules = buildRules([list(["", "   ", "localhost", "10.0.0.1", "reddit.com"])], state());
  assert.equal(rules.length, 1);
});
