import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detect,
  isReflex,
  isIgnored,
  isRootUrl,
  ordinal,
  DEFAULT_DETECTOR,
} from "../src/lib/loop.js";

const NOW = 1_800_000_000_000; // arbitrary epoch ms
const min = (m) => m * 60_000;

function visit(minutesAgo, { domain = "reddit.com", reflex = true, root = true } = {}) {
  return { ts: NOW - min(minutesAgo), domain, host: domain, reflex, root };
}

test("3 reflex visits within 60m trips with trippedBy reflex", () => {
  const visits = [visit(30), visit(10), visit(0)];
  const trip = detect(visits, "reddit.com", NOW, DEFAULT_DETECTOR);
  assert.ok(trip);
  assert.equal(trip.trippedBy, "reflex");
  assert.equal(trip.toolShaped, false);
  assert.equal(trip.domain, "reddit.com");
});

test("2 reflex visits do not trip", () => {
  assert.equal(detect([visit(30), visit(0)], "reddit.com", NOW), null);
});

test("3 reflex visits with the first 61m ago do not trip", () => {
  assert.equal(detect([visit(61), visit(10), visit(0)], "reddit.com", NOW), null);
});

test("a visit exactly on the window edge is outside it", () => {
  assert.equal(detect([visit(60), visit(10), visit(0)], "reddit.com", NOW), null);
  assert.ok(detect([visit(59), visit(10), visit(0)], "reddit.com", NOW));
});

test("5 non-reflex visits trip with trippedBy any and toolShaped true", () => {
  const visits = [40, 30, 20, 10, 0].map((m) => visit(m, { reflex: false, root: false }));
  const trip = detect(visits, "reddit.com", NOW);
  assert.ok(trip);
  assert.equal(trip.trippedBy, "any");
  assert.equal(trip.toolShaped, true);
  assert.equal(trip.count, 5);
  assert.equal(trip.reflexCount, 0);
});

test("5 visits of which 3 reflex trips (by reflex) with toolShaped false", () => {
  const visits = [
    visit(40, { reflex: false }),
    visit(30),
    visit(20, { reflex: false }),
    visit(10),
    visit(0),
  ];
  const trip = detect(visits, "reddit.com", NOW);
  assert.ok(trip);
  assert.equal(trip.toolShaped, false);
  assert.equal(trip.count, 5);
  assert.equal(trip.reflexCount, 3);
});

test("toolShaped needs a strict majority of non-reflex arrivals", () => {
  // 2 reflex of 5: 2*2 < 5 → toolShaped.
  const twoOfFive = [
    visit(40, { reflex: false }),
    visit(30),
    visit(20, { reflex: false }),
    visit(10, { reflex: false }),
    visit(0),
  ];
  const trip = detect(twoOfFive, "reddit.com", NOW);
  assert.equal(trip.trippedBy, "any");
  assert.equal(trip.toolShaped, true);
  // 3 reflex of 6 trips by reflex first, so never toolShaped.
  const threeOfSix = [...twoOfFive, visit(5)];
  const trip6 = detect(threeOfSix, "reddit.com", NOW);
  assert.equal(trip6.trippedBy, "reflex");
  assert.equal(trip6.toolShaped, false);
  // With reflexThreshold raised, 3 reflex of 6 trips by any and 6 < 6 is false.
  const cfg = { ...DEFAULT_DETECTOR, reflexThreshold: 10 };
  const tripAny = detect(threeOfSix, "reddit.com", NOW, cfg);
  assert.equal(tripAny.trippedBy, "any");
  assert.equal(tripAny.toolShaped, false);
});

test("4 non-reflex visits do not trip", () => {
  const visits = [30, 20, 10, 0].map((m) => visit(m, { reflex: false }));
  assert.equal(detect(visits, "reddit.com", NOW), null);
});

test("visits to other domains never count", () => {
  const visits = [
    visit(30, { domain: "discord.com" }),
    visit(20, { domain: "discord.com" }),
    visit(10),
    visit(0),
  ];
  assert.equal(detect(visits, "reddit.com", NOW), null);
  assert.equal(detect(visits, "discord.com", NOW), null);
});

test("result carries count, reflexCount, rootCount, firstTs, windowMinutes", () => {
  const visits = [
    visit(45, { reflex: true, root: true }),
    visit(20, { reflex: false, root: false }),
    visit(5, { reflex: true, root: false }),
    visit(0, { reflex: true, root: true }),
    visit(90), // outside window
  ];
  const trip = detect(visits, "reddit.com", NOW);
  assert.equal(trip.count, 4);
  assert.equal(trip.reflexCount, 3);
  assert.equal(trip.rootCount, 2);
  assert.equal(trip.firstTs, NOW - min(45));
  assert.equal(trip.windowMinutes, 60);
});

test("custom config is honored", () => {
  const cfg = { windowMinutes: 10, reflexThreshold: 2, anyThreshold: 3 };
  assert.ok(detect([visit(5), visit(0)], "reddit.com", NOW, cfg));
  assert.equal(detect([visit(11), visit(0)], "reddit.com", NOW, cfg), null);
  const links = [4, 2, 0].map((m) => visit(m, { reflex: false }));
  assert.equal(detect(links, "reddit.com", NOW, cfg).trippedBy, "any");
  assert.equal(detect(links.slice(1), "reddit.com", NOW, cfg), null);
});

test("empty log returns null", () => {
  assert.equal(detect([], "reddit.com", NOW), null);
});

test("isReflex: typed/generated/auto_bookmark/keyword", () => {
  const prev = "https://news.ycombinator.com/";
  for (const t of ["typed", "generated", "auto_bookmark", "keyword"]) {
    assert.equal(isReflex({ transitionType: t }, prev), true, t);
  }
});

test("isReflex: link from a new-tab previous URL is a reflex", () => {
  for (const prev of ["chrome://newtab/", "about:newtab", "about:home", "about:blank"]) {
    assert.equal(isReflex({ transitionType: "link" }, prev), true, prev);
  }
  assert.equal(isReflex({ transitionType: "link" }, undefined), true, "no previous url");
  assert.equal(isReflex({ transitionType: "link" }, null), true, "null previous url");
});

test("isReflex: link from another http page is not a reflex", () => {
  assert.equal(isReflex({ transitionType: "link" }, "https://news.ycombinator.com/"), false);
  assert.equal(isReflex({ transitionType: "form_submit" }, "https://google.com/search?q=x"), false);
  assert.equal(isReflex({ transitionType: "reload" }, "https://reddit.com/"), false);
});

test("isRootUrl", () => {
  assert.equal(isRootUrl("https://reddit.com/"), true);
  assert.equal(isRootUrl("https://reddit.com"), true);
  assert.equal(isRootUrl("https://reddit.com/?utm=1"), false);
  assert.equal(isRootUrl("https://reddit.com/r/adops"), false);
  assert.equal(isRootUrl("not a url"), false);
});

test("ignore matching: host-scoped entry skips that host only", () => {
  const ignored = [{ match: "ads.reddit.com", scope: "host", until: NOW + min(60) }];
  assert.equal(isIgnored(ignored, "reddit.com", "ads.reddit.com", NOW), true);
  assert.equal(isIgnored(ignored, "reddit.com", "reddit.com", NOW), false);
  assert.equal(isIgnored(ignored, "reddit.com", "old.reddit.com", NOW), false);
});

test("ignore matching: domain-scoped entry skips all subdomains", () => {
  const ignored = [{ match: "atlassian.net", scope: "domain", until: NOW + min(60) }];
  assert.equal(isIgnored(ignored, "atlassian.net", "highway.atlassian.net", NOW), true);
  assert.equal(isIgnored(ignored, "atlassian.net", "atlassian.net", NOW), true);
  assert.equal(isIgnored(ignored, "reddit.com", "reddit.com", NOW), false);
});

test("ignore matching: expired entries do not match", () => {
  const ignored = [{ match: "atlassian.net", scope: "domain", until: NOW - 1 }];
  assert.equal(isIgnored(ignored, "atlassian.net", "highway.atlassian.net", NOW), false);
});

test("ordinal", () => {
  assert.equal(ordinal(1), "1st");
  assert.equal(ordinal(2), "2nd");
  assert.equal(ordinal(3), "3rd");
  assert.equal(ordinal(4), "4th");
  assert.equal(ordinal(11), "11th");
  assert.equal(ordinal(12), "12th");
  assert.equal(ordinal(13), "13th");
  assert.equal(ordinal(21), "21st");
  assert.equal(ordinal(22), "22nd");
  assert.equal(ordinal(103), "103rd");
});
